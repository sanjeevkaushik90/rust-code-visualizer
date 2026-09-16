use std::fs::{self};

fn main() {
    let contents = match fs::read_to_string("example.rs") {
        Ok(content) => content,
        Err(e) => {
            println!("{}", e);
            return;
        }
    };

    for (index, line) in contents.lines().enumerate() {
        let index = index + 1;

        let clean_line = line.trim();

        if clean_line.starts_with("let ") {
            println!("line {} : variable declare ", index);
        }
    }
}
