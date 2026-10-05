use axum_entity_server::create_app;

#[tokio::main]
async fn main() {
    let app = create_app();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
    println!("Axum entity server listening on 127.0.0.1:3000");
    axum::serve(listener, app).await.unwrap();
}
