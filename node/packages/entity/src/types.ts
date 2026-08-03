export type FieldType = 'str' | 'int' | 'float' | 'bool' | 'datetime' | 'enum' | 'ref' | 'list' | 'obj';
export type Transport = 'rest' | 'rpc' | 'sse' | 'ws';
export type Op = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface FieldSpec {
  name: string;
  type: FieldType;
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
  stateField?: string;
  from?: string;
  to?: string;
  input?: FieldSpec[];
  transactional?: false;
}

export interface EntitySpec {
  specVersion: '1.1.0';
  entity: string;
  path: string;
  transports: Transport[];
  ops: Op[];
  pagination: 'offset' | 'cursor';
  fields: FieldSpec[];
  actions?: ActionSpec[];
}

export interface MutableEntitySpec extends Partial<EntitySpec> {
  fields: FieldSpec[];
  actions: ActionSpec[];
}
