import server_decorator/entity
restful "things":
  type Thing = object
    id {.role: "id", readonly.}: string
    email {.format: "email", pattern: "^x$".}: string
