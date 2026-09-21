//! Prepare under SQLite's authorizer to validate actual syntax, not SQL string prefixes.

use crate::{invalid, Result};
use libsqlite3_sys as ffi;
use sqlx::SqliteConnection;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr;

unsafe extern "C" fn authorize(
    _context: *mut c_void,
    action: c_int,
    _first: *const c_char,
    second: *const c_char,
    _database: *const c_char,
    _trigger: *const c_char,
) -> c_int {
    if matches!(
        action,
        ffi::SQLITE_TRANSACTION | ffi::SQLITE_SAVEPOINT | ffi::SQLITE_ATTACH | ffi::SQLITE_DETACH | ffi::SQLITE_PRAGMA
    ) {
        return ffi::SQLITE_DENY;
    }

    if action == ffi::SQLITE_FUNCTION && !second.is_null() {
        let name = unsafe { CStr::from_ptr(second) }.to_bytes();
        if name.eq_ignore_ascii_case(b"load_extension") {
            return ffi::SQLITE_DENY;
        }
    }

    ffi::SQLITE_OK
}

pub(crate) async fn validate(
    connection: &mut SqliteConnection,
    sql: &str,
    parameters: usize,
    readonly: bool,
) -> Result<(Vec<String>, bool)> {
    if sql.is_empty() || sql.len() > 65536 || parameters > 128 {
        return Err(invalid("SQL or parameter count exceeds limits"));
    }
    let sql = CString::new(sql).map_err(|_| invalid("SQL contains NUL"))?;
    let mut handle = connection.lock_handle().await?;
    let db = handle.as_raw_handle().as_ptr();
    let mut statement = ptr::null_mut();
    let mut tail = ptr::null();

    // The SQLx worker is paused by lock_handle; reset the authorizer before resuming it.
    // No await or early return occurs between installation and removal.
    let result = unsafe {
        ffi::sqlite3_set_authorizer(db, Some(authorize), ptr::null_mut());
        let code = ffi::sqlite3_prepare_v2(db, sql.as_ptr(), -1, &mut statement, &mut tail);
        ffi::sqlite3_set_authorizer(db, None, ptr::null_mut());

        let result = if code != ffi::SQLITE_OK {
            Err(invalid(CStr::from_ptr(ffi::sqlite3_errmsg(db)).to_string_lossy()))
        } else if statement.is_null() {
            Err(invalid("An executable SQL statement is required"))
        } else if !CStr::from_ptr(tail).to_bytes().iter().all(u8::is_ascii_whitespace) {
            Err(invalid("Exactly one SQL statement is required"))
        } else if ffi::sqlite3_bind_parameter_count(statement) as usize != parameters {
            Err(invalid("SQL parameter count mismatch"))
        } else if readonly && ffi::sqlite3_stmt_readonly(statement) == 0 {
            Err(invalid("Query accepts only read-only statements"))
        } else {
            let columns = (0..ffi::sqlite3_column_count(statement))
                .map(|index| {
                    CStr::from_ptr(ffi::sqlite3_column_name(statement, index))
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            Ok((columns, ffi::sqlite3_stmt_readonly(statement) != 0))
        };
        if !statement.is_null() {
            ffi::sqlite3_finalize(statement);
        }
        result
    };
    result
}
