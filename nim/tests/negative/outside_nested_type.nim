import server_decorator/entity
type Addr = object
  city: string
restful "things":
  type Thing = object
    id {.role: "id", readonly.}: string
    home: Addr
