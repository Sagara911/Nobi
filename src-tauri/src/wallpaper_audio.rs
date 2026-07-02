//! 桌面音频可视化壁纸 —— 系统音频采集（WASAPI loopback）+ FFT 分频。
//!
//! 不依赖任何音乐平台登录：直接抓「当前扬声器在放什么」（loopback），做 FFT 后
//! 切成若干对数间隔的频段，交给独立 Chromium 渲染器驱动粒子视觉。
//!
//! 本文件只负责「拿到频谱数据」这一层，渲染在别的进程；这是整套壁纸功能的 Phase 1
//! 地基——纯后端、无 WebView，不受本机 WebView2 实时画布渲染坑的影响。
//!
//! Windows 专属（WASAPI）。非 Windows 下命令返回错误占位。

use serde::Serialize;

/// 一次探针采集的结果：用于 Phase 1 验证「有声音时数值会跳」。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbe {
    /// 采样率（Hz）
    pub sample_rate: u32,
    /// 参与 FFT 的单声道样本数
    pub frame_count: usize,
    /// 对数间隔频段的归一化能量（约 0..1.5），长度 = 请求的 bands
    pub bands: Vec<f32>,
    /// 本次窗口内的峰值幅度（快速判断「是否真的有声音」）
    pub peak: f32,
}

/// 打开系统输出的 loopback 采集：返回（已就绪未 start 的 AudioClient, 采集客户端, 每帧字节数, 采样率）。
///
/// loopback 的关键：拿默认「渲染设备」（扬声器），再以 `Capture` 方向初始化——方向与设备类型
/// 不一致时 wasapi 自动开启 loopback 标志，于是采到的是「正在外放的声音」。
///
/// 一次性探针（本文件）与持续推流（[`crate::wallpaper_stream`]）共用这套初始化，避免重复。
/// 调用方负责 `start_stream()` 与后续读取——采集客户端不能跨线程，须在使用线程内打开。
#[cfg(windows)]
pub(crate) fn open_loopback(
) -> Result<(wasapi::AudioClient, wasapi::AudioCaptureClient, usize, u32), String> {
    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;

    // 统一要 f32 立体声 48kHz；autoconvert 让 WASAPI 把混音格式转成这个。
    let format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
    let (def_time, _min_time) = audio_client.get_device_period().map_err(|e| e.to_string())?;
    let mode = StreamMode::PollingShared {
        autoconvert: true,
        buffer_duration_hns: def_time,
    };
    audio_client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| e.to_string())?;

    let block_align = format.get_blockalign() as usize; // 每帧字节数（f32 × 2ch = 8）
    let sample_rate = format.get_samplespersec();
    let capture = audio_client
        .get_audiocaptureclient()
        .map_err(|e| e.to_string())?;
    Ok((audio_client, capture, block_align, sample_rate))
}

/// 交错 f32 字节流 → 混单声道样本（取左右声道均值）。
pub(crate) fn bytes_to_mono(bytes: &[u8], block_align: usize) -> Vec<f32> {
    if block_align < 8 {
        return Vec::new();
    }
    let frames = bytes.len() / block_align;
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * block_align;
        let l = f32::from_le_bytes([bytes[base], bytes[base + 1], bytes[base + 2], bytes[base + 3]]);
        let r = f32::from_le_bytes([
            bytes[base + 4],
            bytes[base + 5],
            bytes[base + 6],
            bytes[base + 7],
        ]);
        mono.push((l + r) * 0.5);
    }
    mono
}

/// 采集一段系统输出音频，返回（混单声道样本, 采样率）。一次性探针用。
#[cfg(windows)]
fn capture_loopback(duration_ms: u64) -> Result<(Vec<f32>, u32), String> {
    use std::collections::VecDeque;
    use wasapi::initialize_mta;

    // wasapi 要求调用线程处于 MTA 套间。initialize_mta() 返回 HRESULT，.ok() → Result。
    initialize_mta().ok().map_err(|e| e.to_string())?;

    let (audio_client, capture, block_align, sample_rate) = open_loopback()?;
    audio_client.start_stream().map_err(|e| e.to_string())?;

    // 轮询采集 duration_ms 毫秒。
    let mut queue: VecDeque<u8> = VecDeque::new();
    let step = 10u64;
    let mut waited = 0u64;
    while waited < duration_ms {
        capture
            .read_from_device_to_deque(&mut queue)
            .map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(step));
        waited += step;
    }
    let _ = audio_client.stop_stream();

    let bytes: Vec<u8> = queue.into_iter().collect();
    Ok((bytes_to_mono(&bytes, block_align), sample_rate))
}

/// 对单声道样本做 FFT，切成 `num_bands` 个对数间隔频段的归一化能量。
///
/// Phase 1 只求「能眼看出跳动」，归一化是粗略的；正式版会做时间平滑与自动增益。
pub(crate) fn compute_bands(samples: &[f32], sample_rate: u32, num_bands: usize) -> Vec<f32> {
    use rustfft::{num_complex::Complex, FftPlanner};
    if samples.len() < 64 || num_bands == 0 || sample_rate == 0 {
        return vec![0.0; num_bands];
    }
    // 取不超过样本数的最大 2 次幂（上限 8192）作为 FFT 窗口。
    let mut n = 1usize;
    while n * 2 <= samples.len() && n < 8192 {
        n *= 2;
    }

    // Hann 窗，减少频谱泄漏。
    let mut buf: Vec<Complex<f32>> = (0..n)
        .map(|i| {
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0)).cos();
            Complex {
                re: samples[i] * w,
                im: 0.0,
            }
        })
        .collect();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    fft.process(&mut buf);

    let half = n / 2;
    let nyquist = sample_rate as f32 / 2.0;
    let min_hz = 30.0f32;
    let max_hz = nyquist.min(16000.0);
    let ratio = max_hz / min_hz;

    let mut bands = vec![0.0f32; num_bands];
    for (b, slot) in bands.iter_mut().enumerate() {
        let f_lo = min_hz * ratio.powf(b as f32 / num_bands as f32);
        let f_hi = min_hz * ratio.powf((b + 1) as f32 / num_bands as f32);
        let k_lo = ((f_lo / nyquist) * half as f32).floor() as usize;
        let k_hi = (((f_hi / nyquist) * half as f32).ceil() as usize)
            .max(k_lo + 1)
            .min(half);
        let mut sum = 0.0f32;
        let mut cnt = 0u32;
        for c in buf.iter().take(k_hi).skip(k_lo) {
            sum += c.norm();
            cnt += 1;
        }
        let avg = if cnt > 0 { sum / cnt as f32 } else { 0.0 };
        // sqrt 压缩动态范围，让弱信号也看得见。
        *slot = (avg / n as f32 * 4.0).sqrt().min(1.5);
    }
    bands
}

/// Phase 1 验证命令：采集一小段系统音频并返回频段能量 + 峰值。
///
/// 前端/控制台调用后，放音乐时 `bands` 与 `peak` 应随节奏跳动；静音时接近 0。
/// 证明「无登录抓系统音频」这条地基成立，再往渲染器串数据。
#[tauri::command]
pub fn wallpaper_audio_probe(ms: Option<u64>, bands: Option<usize>) -> Result<AudioProbe, String> {
    let dur = ms.unwrap_or(500).clamp(100, 3000);
    let num_bands = bands.unwrap_or(24).clamp(1, 128);

    #[cfg(windows)]
    {
        // 独立线程跑：wasapi 需 MTA，别污染 Tauri 运行时线程的套间。
        let handle = std::thread::spawn(move || capture_loopback(dur));
        let (samples, sample_rate) = handle
            .join()
            .map_err(|_| "音频采集线程崩溃".to_string())??;
        let peak = samples.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        let band_vals = compute_bands(&samples, sample_rate, num_bands);
        Ok(AudioProbe {
            sample_rate,
            frame_count: samples.len(),
            bands: band_vals,
            peak,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (dur, num_bands);
        Err("系统音频采集目前仅支持 Windows".into())
    }
}
