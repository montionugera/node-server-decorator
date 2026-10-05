use server_decorator_entity::testing::user_spec;
use server_decorator_openapi::generate;

fn main() {
    let spec = user_spec();
    let json = generate(&[spec], "1.2.0").expect("failed to generate openapi document");
    print!("{}", json);
}
