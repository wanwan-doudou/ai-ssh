
#[allow(unused_imports)]
use russh_sftp::client::File;

fn check_clone(f: File) {
    let _ = f.clone();
}
