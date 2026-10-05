use server_decorator_entity::canonical::to_canonical_json;
use server_decorator_entity::testing::user_spec;

fn main() {
    let spec = user_spec();
    let json = to_canonical_json(&spec).expect("failed to serialize canonical json");
    print!("{}", json);
}
