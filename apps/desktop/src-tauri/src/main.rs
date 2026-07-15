// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // CLI mode: `pear validate <review.json>` — validate a review.pear.v1 document and
    // exit. This is what `$PEAR_BIN validate …` runs inside peaR-spawned agent sessions,
    // closing the emit→validate→fix loop without any server plumbing.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && args[1] == "validate" {
        std::process::exit(validate(args.get(2).map(String::as_str)));
    }
    desktop_lib::run()
}

fn validate(path: Option<&str>) -> i32 {
    let Some(path) = path else {
        eprintln!("usage: pear validate <review.json>");
        return 2;
    };
    let json = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("INVALID: cannot read {path}: {e}");
            return 2;
        }
    };
    match pear_core::review_doc::ReviewDoc::parse(&json) {
        Ok((doc, warnings)) => {
            for w in &warnings {
                println!("warning: {w}");
            }
            println!(
                "VALID — review.pear.v1 · {} finding(s) · {} warning(s)",
                doc.findings.len(),
                warnings.len()
            );
            0
        }
        Err(errors) => {
            for e in errors.split("; ") {
                eprintln!("error: {e}");
            }
            eprintln!("INVALID — fix the errors above and re-run");
            1
        }
    }
}
