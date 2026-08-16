export type FieldType = 'str' | 'int' | 'float' | 'bool' | 'datetime' | 'enum' | 'ref' | 'list' | 'obj';
export type Transport = 'rest' | 'rpc' | 'sse' | 'ws';
export type Op = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface FieldSpec {
  name: string;
  type: FieldType;
  description?: string;
  role?: 'id';
  format?: 'email' | 'uuid' | 'uri';
  enum?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  optional?: true;
  nullable?: true;
  readonly?: true;
  writeonly?: true;
  filterable?: true;
  item?: FieldSpec;
  ref?: string;
  fields?: FieldSpec[];
}

export interface ActionSpec {
  name: string;
  description?: string;
  stateField?: string;
  from?: string;
  to?: string;
  input?: FieldSpec[];
  transactional?: false;
}

export interface SecurityScheme {
  name: string;
  type: 'http' | 'apiKey';
  scheme?: 'bearer' | 'basic';
  bearerFormat?: string;
  in?: 'header' | 'query' | 'cookie';
  paramName?: string;
}

export interface SecuritySpec {
  schemes: SecurityScheme[];
  ops?: Record<string, string[]>;
  actions?: Record<string, string[]>;
}

export interface EntitySpec {
  specVersion: '1.2.0';
  entity: string;
  path: string;
  transports: Transport[];
  ops: Op[];
  pagination: 'offset' | 'cursor';
  fields: FieldSpec[];
  actions?: ActionSpec[];
  description?: string;
  tags?: string[];
  security?: SecuritySpec;
}

export interface MutableEntitySpec extends Partial<EntitySpec> {
  fields: FieldSpec[];
  actions: ActionSpec[];
}
