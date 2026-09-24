mod tokenizer;

use std::ffi::{c_char, c_int, c_void};

use crate::tokenizer::{
    Tokenizer, get_character_tokenizer, get_standard_index_tokenizer, get_standard_search_tokenizer,
};

unsafe extern "C" {
    fn register_xiaowei_tokenizers(
        db: *mut libsqlite3_sys::sqlite3,
        p_api: *mut libsqlite3_sys::sqlite3_api_routines,
    ) -> c_int;
}

/// Register the Xiaowei FTS5 tokenizer on one SQLite connection.
///
/// # Safety
/// `db` must be an open connection from the linked libsqlite3-sys instance.
/// The caller must hold exclusive access to it for the duration of registration.
pub unsafe fn register(db: *mut libsqlite3_sys::sqlite3) -> c_int {
    unsafe { register_xiaowei_tokenizers(db, std::ptr::null_mut()) }
}

#[repr(C)]
pub struct XiaoweiTokenizer {
    tp: i32,
}

#[unsafe(no_mangle)]
extern "C" fn tokenize_impl(
    tokenizer: *const XiaoweiTokenizer,
    p_ctx: *mut c_void,
    flags: c_int,
    p_text: *const c_char,
    n_text: c_int,
    token_callback: Option<unsafe extern "C" fn(*mut c_void, c_int, *const c_char, c_int, c_int, c_int) -> c_int>,
) -> c_int {
    let is_query = (flags & libsqlite3_sys::FTS5_TOKENIZE_QUERY as c_int) != 0;
    let mut tokenizer = match (unsafe { (*tokenizer).tp }, is_query) {
        (1, false) => get_standard_index_tokenizer(),
        (1, true) => get_standard_search_tokenizer(),
        (2, _) => get_character_tokenizer(),
        _ => return libsqlite3_sys::SQLITE_ERROR as c_int,
    };

    let text =
        unsafe { std::str::from_utf8(std::slice::from_raw_parts(p_text as *const u8, n_text as usize)).unwrap_or("") };
    let mut stream = tokenizer.token_stream(text);
    let mut tokens = Vec::new();
    while let Some(token) = stream.next() {
        tokens.push(token.clone());
    }
    if !is_query {
        // Jieba emits overlapping search subwords before their original word.
        // Emit the covering word first so its subwords share one FTS5 position.
        tokens.sort_by(|a, b| a.offset_from.cmp(&b.offset_from).then(b.offset_to.cmp(&a.offset_to)));
    }

    let mut position_end = 0;
    for token in tokens {
        let token_flags = if !is_query && token.offset_from < position_end {
            libsqlite3_sys::FTS5_TOKEN_COLOCATED as c_int
        } else {
            0
        };
        position_end = position_end.max(token.offset_to);
        match unsafe {
            token_callback.unwrap()(
                p_ctx,
                token_flags,
                token.text.as_ptr() as *const c_char,
                token.text.len() as c_int,
                token.offset_from as c_int,
                token.offset_to as c_int,
            )
        } {
            0 => (), // SQLITE_OK
            code => return code,
        }
    }

    libsqlite3_sys::SQLITE_OK as c_int
}
