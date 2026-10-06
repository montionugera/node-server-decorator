use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum_entity_server::create_app;
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn test_e2e_user_lifecycle_and_validation() {
    let app = create_app();

    // 1. Initially empty list
    let req = Request::builder()
        .method("GET")
        .uri("/users")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let list_json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(list_json["total"], 0);
    assert_eq!(list_json["items"].as_array().unwrap().len(), 0);

    // 2. Reject Create missing email
    let req = Request::builder()
        .method("POST")
        .uri("/users")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "name": "Mont",
                "status": "inactive",
                "tags": []
            })
            .to_string(),
        ))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let err_json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        err_json["fields"].as_array().unwrap(),
        &vec![json!("email")]
    );

    // 3. Reject Create with readonly loginCount
    let req = Request::builder()
        .method("POST")
        .uri("/users")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "email": "mont@example.com",
                "name": "Mont",
                "status": "inactive",
                "tags": [],
                "loginCount": 5
            })
            .to_string(),
        ))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let err_json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        err_json["fields"].as_array().unwrap(),
        &vec![json!("loginCount")]
    );

    // 4. Create valid user -> returns 201 Created
    let req = Request::builder()
        .method("POST")
        .uri("/users")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "email": "mont@example.com",
                "name": "Mont",
                "status": "inactive",
                "tags": ["admin"]
            })
            .to_string(),
        ))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let created_user: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(created_user["id"], "user-1");
    assert_eq!(created_user["status"], "inactive");
    assert_eq!(created_user["loginCount"], 0);

    // 5. Get user by ID -> 200 OK
    let req = Request::builder()
        .method("GET")
        .uri("/users/user-1")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let fetched_user: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fetched_user["email"], "mont@example.com");

    // 5b. Reject Update with readonly loginCount
    let req = Request::builder()
        .method("PATCH")
        .uri("/users/user-1")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "loginCount": 99 }).to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // 6. Update user with Patch -> 200 OK
    let req = Request::builder()
        .method("PATCH")
        .uri("/users/user-1")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "name": "Mont Nu" }).to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let updated_user: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(updated_user["name"], "Mont Nu");

    // 7. Trigger action "activate" with reason -> 200 OK
    let req = Request::builder()
        .method("POST")
        .uri("/users/user-1/actions/activate")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "reason": "Verified" }).to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let activated_user: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(activated_user["status"], "active");

    // 8. Delete user -> 204 No Content
    let req = Request::builder()
        .method("DELETE")
        .uri("/users/user-1")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // 9. Get deleted user -> 404 Not Found Problem
    let req = Request::builder()
        .method("GET")
        .uri("/users/user-1")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // 10. Update deleted user -> 404 Not Found
    let req = Request::builder()
        .method("PATCH")
        .uri("/users/user-1")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "name": "Nobody" }).to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // 11. Delete nonexistent user -> 404 Not Found
    let req = Request::builder()
        .method("DELETE")
        .uri("/users/nonexistent")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // 12. Action with unknown action name -> 400 Bad Request (ValidationProblem)
    let req = Request::builder()
        .method("POST")
        .uri("/users/user-1/actions/unknown")
        .header("content-type", "application/json")
        .body(Body::from(json!({}).to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // 13. Action on nonexistent user -> 404 Not Found
    let req = Request::builder()
        .method("POST")
        .uri("/users/nonexistent/actions/activate")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "reason": "ok" }).to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // 14. List with query params
    let req = Request::builder()
        .method("GET")
        .uri("/users?limit=10&offset=0&status=active")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
