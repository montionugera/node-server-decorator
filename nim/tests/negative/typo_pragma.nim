import server_decorator/entity
restful "things":
  type Thing = object
    id {.rolee: "id".}: string
