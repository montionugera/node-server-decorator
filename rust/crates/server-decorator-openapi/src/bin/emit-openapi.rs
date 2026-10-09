use server_decorator_entity::testing::user_spec;
use server_decorator_openapi::generate;

fn main() {
    let spec = user_spec();
    // Read at run time, not include_str!: the file lives outside this crate, so a compile-time
    // include breaks `cargo package`/`cargo publish` verification of the packaged tarball.
    let version_file = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../contracts/VERSION");
    let version = std::fs::read_to_string(version_file).expect("failed to read contracts/VERSION");
    let version = version.trim();
    let json = generate(&[spec], version).expect("failed to generate openapi document");
    print!("{}", json);
}
