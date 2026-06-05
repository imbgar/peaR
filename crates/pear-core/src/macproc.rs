//! Read a process's current working directory the macOS way — `proc_pidinfo` with
//! `PROC_PIDVNODEPATHINFO`. Used to capture a shell tab's *live* cwd at save time, so
//! persist-session restores the directory you `cd`'d to, not where the shell started.
//!
//! No extra dependency: `libc` is already in the tree and exposes the syscall + struct
//! on Apple targets. Non-macOS builds get a `None` stub.

/// The current working directory of `pid`, if it can be read.
#[cfg(target_os = "macos")]
pub fn cwd_of(pid: u32) -> Option<String> {
    use std::ffi::CStr;

    // SAFETY: zero-initialised POD; `proc_pidinfo` fills `pvi_cdir.vip_path` (a NUL-terminated
    // C path) and returns the bytes written (>0) on success.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if written < size {
        return None;
    }
    // `vip_path` is a contiguous `[[c_char; 32]; 32]` (MAXPATHLEN); read it as a flat
    // NUL-terminated C string.
    let path = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char) };
    path.to_str()
        .ok()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

#[cfg(not(target_os = "macos"))]
pub fn cwd_of(_pid: u32) -> Option<String> {
    None
}
