//! 缩略图与主色调：为素材生成 400px 缓存缩略图并提取主色。
//! 进度通过 "thumb-progress" 事件推给前端。

use std::collections::HashMap;

use tauri::Emitter;

use crate::db::{open_db, thumbs_dir, MEDIA_FORMATS_SQL};

/// 从图像中提取主色调（量化到 8 级/通道，双轨选色）。
/// 纯按像素数投票时，暗调图会被大面积深底霸榜，红发/烛光等小面积主题色进不了前五。
/// 策略：前 2 个名额给"面积最大"的基调色（诚实反映底色），
/// 后 3 个名额给"鲜艳度得分(∑饱和度×亮度)"最高的点缀色，且彼此去相近。
fn dominant_colors(img: &image::DynamicImage) -> Vec<String> {
    let small = img.thumbnail(64, 64).to_rgb8();
    // 桶 → (像素数, 鲜艳度累计)
    let mut buckets: HashMap<(u8, u8, u8), (u32, f32)> = HashMap::new();
    for p in small.pixels() {
        let (r, g, b) = (p[0], p[1], p[2]);
        let mx = r.max(g).max(b) as f32;
        let mn = r.min(g).min(b) as f32;
        let sat = if mx == 0.0 { 0.0 } else { (mx - mn) / mx };
        let val = mx / 255.0;
        let e = buckets.entry((r >> 5, g >> 5, b >> 5)).or_insert((0, 0.0));
        e.0 += 1;
        e.1 += sat * val;
    }

    let center = |(r, g, b): (u8, u8, u8)| -> (i32, i32, i32) {
        ((((r as i32) << 5) | 16), (((g as i32) << 5) | 16), (((b as i32) << 5) | 16))
    };
    let far = |out: &Vec<(i32, i32, i32)>, c: (i32, i32, i32)| {
        out.iter()
            .all(|(or, og, ob)| (c.0 - or).abs() + (c.1 - og).abs() + (c.2 - ob).abs() >= 64)
    };

    let mut out: Vec<(i32, i32, i32)> = Vec::new();

    // 轨道一：面积最大的基调色，取 2 个
    let mut by_count: Vec<_> = buckets.iter().collect();
    by_count.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    for (k, _) in by_count.iter() {
        if out.len() >= 2 {
            break;
        }
        let c = center(**k);
        if far(&out, c) {
            out.push(c);
        }
    }

    // 轨道二：鲜艳度最高的点缀色，补满 5 个
    let mut by_vib: Vec<_> = buckets.iter().collect();
    by_vib.sort_by(|a, b| b.1 .1.partial_cmp(&a.1 .1).unwrap_or(std::cmp::Ordering::Equal));
    for (k, (_, vib)) in by_vib.iter() {
        if out.len() >= 5 {
            break;
        }
        if *vib <= 0.5 {
            break; // 鲜艳度太低就不硬凑
        }
        let c = center(**k);
        if far(&out, c) {
            out.push(c);
        }
    }

    out.into_iter()
        .map(|(r, g, b)| format!("#{:02x}{:02x}{:02x}", r, g, b))
        .collect()
}

/// 为缺缩略图或缺主色的素材补齐缩略图(400px PNG)与主色调。返回本次处理数量。
#[tauri::command]
pub fn build_thumbnails(app: tauri::AppHandle) -> Result<usize, String> {
    let dir = thumbs_dir(&app)?;
    let conn = open_db(&app)?;

    let todo: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id,path,COALESCE(thumb,'') FROM assets
                 WHERE (thumb IS NULL OR thumb='' OR colors IS NULL OR colors='')
                 AND UPPER(COALESCE(format,'')) NOT IN {MEDIA_FORMATS_SQL}"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let total = todo.len();
    // 进度事件限频：全程最多约 100 次（大库时每 3 张发一次会发上万次，把前端 UI 线程刷爆→未响应）
    let step = (total / 100).max(1);
    let mut done = 0usize;
    let mut seen = 0usize;
    for (id, path, thumb) in todo {
        seen += 1;
        if seen % step == 0 || seen == total {
            let _ = app.emit(
                "thumb-progress",
                serde_json::json!({ "done": seen, "total": total }),
            );
        }
        let mut thumb_str = thumb.clone();
        // 优先用已有缩略图（小图、解码快）来算主色；没有则解码原图并生成缩略图
        let work: Option<image::DynamicImage> =
            if !thumb.is_empty() && std::path::Path::new(&thumb).exists() {
                image::open(&thumb).ok()
            } else if let Ok(img) = image::open(&path) {
                let t = img.thumbnail(400, 400);
                let tp = dir.join(format!("{id}.png"));
                if t.save(&tp).is_ok() {
                    thumb_str = tp.to_string_lossy().to_string();
                }
                Some(t)
            } else {
                None
            };

        if let Some(im) = work {
            let colors = dominant_colors(&im);
            let cj = serde_json::to_string(&colors).unwrap_or_else(|_| "[]".to_string());
            let _ = conn.execute(
                "UPDATE assets SET thumb=?1, colors=?2 WHERE id=?3",
                rusqlite::params![thumb_str, cj, id],
            );
            done += 1;
        }
    }
    Ok(done)
}

/// 前端渲染的封面写回（3D 模型查看器首帧等）：
/// 收 PNG base64 → 缩到 400px 存缓存目录 → 顺带提主色，更新 thumb+colors。
#[tauri::command]
pub fn set_thumb(app: tauri::AppHandle, id: i64, data_b64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let thumb = img.thumbnail(400, 400);
    let dir = thumbs_dir(&app)?;
    let tp = dir.join(format!("{id}.png"));
    thumb.save(&tp).map_err(|e| e.to_string())?;
    let colors = dominant_colors(&thumb);
    let cj = serde_json::to_string(&colors).unwrap_or_else(|_| "[]".to_string());
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE assets SET thumb=?1, colors=?2 WHERE id=?3",
        rusqlite::params![tp.to_string_lossy().to_string(), cj, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(tp.to_string_lossy().to_string())
}
