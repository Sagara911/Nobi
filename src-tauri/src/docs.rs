//! 文档（Word 式富文本）持久化：多文档存 SQLite。内容是 TipTap 导出的 HTML 串。
//! 同画板：localStorage 只当快取，这里是权威副本。

use serde::Serialize;

use crate::db::{now_secs, open_db};

#[derive(Serialize)]
pub struct DocMeta {
    pub id: i64,
    pub name: String,
    pub updated_at: i64,
}

/// 文档列表（库里一篇都没有时自动建默认文档，保证永远至少一篇）
#[tauri::command]
pub fn list_docs(app: tauri::AppHandle) -> Result<Vec<DocMeta>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT id, COALESCE(name,'文档'), COALESCE(updated_at,0) FROM docs ORDER BY updated_at DESC, id DESC")
        .map_err(|e| e.to_string())?;
    let mut rows: Vec<DocMeta> = stmt
        .query_map([], |r| {
            Ok(DocMeta {
                id: r.get(0)?,
                name: r.get(1)?,
                updated_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    if rows.is_empty() {
        conn.execute(
            "INSERT INTO docs(id,name,content,updated_at) VALUES(1,'未命名文档','',?1)",
            rusqlite::params![now_secs()],
        )
        .map_err(|e| e.to_string())?;
        rows.push(DocMeta {
            id: 1,
            name: "未命名文档".into(),
            updated_at: now_secs(),
        });
    }
    Ok(rows)
}

/// 新建文档，返回 id
#[tauri::command]
pub fn create_doc(app: tauri::AppHandle, name: String) -> Result<i64, String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO docs(name,content,updated_at) VALUES(?1,'',?2)",
        rusqlite::params![name, now_secs()],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn rename_doc(app: tauri::AppHandle, id: i64, name: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE docs SET name=?2 WHERE id=?1",
        rusqlite::params![id, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_doc(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM docs WHERE id=?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存文档内容（HTML），同时可更新标题
#[tauri::command]
pub fn save_doc(app: tauri::AppHandle, id: i64, name: String, content: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO docs(id,name,content,updated_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET name=?2, content=?3, updated_at=?4",
        rusqlite::params![id, name, content, now_secs()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取文档内容（无则 None）
#[tauri::command]
pub fn load_doc(app: tauri::AppHandle, id: i64) -> Result<Option<String>, String> {
    let conn = open_db(&app)?;
    let r = conn.query_row(
        "SELECT content FROM docs WHERE id=?1",
        rusqlite::params![id],
        |r| r.get::<_, String>(0),
    );
    match r {
        Ok(s) => Ok(Some(s)),
        _ => Ok(None),
    }
}
