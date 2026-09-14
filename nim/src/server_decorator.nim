## server_decorator — Nim lane. `import server_decorator` re-exports the entity IR layer and the
## OpenAPI generator; `import server_decorator/entity` alone pulls only the IR layer.
import ./server_decorator/entity, ./server_decorator/gen_openapi
export entity, gen_openapi
