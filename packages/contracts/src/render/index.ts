/**
 * Barrel for the typed render contracts (Epic T10114, ADR-077).
 *
 * Icon enums are intentionally omitted — they ship with T10127 (B2).
 *
 * @epic T10114
 */

export type { RenderableEnvelope, SectionResponse } from './envelope.js';
export {
  isGenericEnvelope,
  isGroupedListEnvelope,
  isListEnvelope,
  isSectionEnvelope,
  isSingleEnvelope,
  isTableEnvelope,
  isTreeEnvelope,
} from './envelope.js';
export type {
  GroupedListResponse,
  ListGroup,
  ListItemStyle,
  ListResponse,
} from './list.js';
export { isGroupedListResponse, isListResponse } from './list.js';
export type {
  ColumnAlign,
  TableColumn,
  TableResponse,
  TableSchema,
} from './table.js';
export { isTableResponse } from './table.js';
export type {
  FlatTreeNode,
  RenderTreeOptions,
  TreeNodeKind,
  TreeNodeStatus,
  TreeResponse,
} from './tree.js';
export { isTreeResponse } from './tree.js';
