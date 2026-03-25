export type DirectiveType = 'actionable' | 'routing' | 'informational';
export interface ParsedCANTMessage {
  directive?: string;
  directive_type: DirectiveType;
  addresses: string[];
  task_refs: string[];
  tags: string[];
  header_raw: string;
  body: string;
}
//# sourceMappingURL=types.d.ts.map
