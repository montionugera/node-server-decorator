use server_decorator_entity::testing::user_spec;
use server_decorator_openapi::generate;

fn main() {
    let spec = user_spec();
    let version = include_str!("../../../../../contracts/VERSION").trim();
    let json = generate(&[spec], version).expect("failed to generate openapi document");
    print!("{}", json);
}
