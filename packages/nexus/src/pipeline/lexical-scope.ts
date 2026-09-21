/** Shared TypeScript/JavaScript lexical ownership and binding model. @task T12264 */
import type {
  GraphLexicalBinding,
  GraphLexicalResolution,
  GraphLexicalScope,
  GraphSourceSpan,
} from '@cleocode/contracts/graph';
import type Parser from 'tree-sitter';

/** Callable/class declaration identity used by every reference extractor. */
export interface LexicalDeclaration {
  /** Qualified graph identity; anonymous identities also include their generation. */
  id: string;
  /** Visible name or explicit anonymous label. */
  name: string;
  /** Graph declaration kind. */
  kind: 'function' | 'method' | 'class';
  /** Owning declaration, absent for module-level declarations. */
  parentId?: string;
  /** Original declaration syntax. */
  node: Parser.SyntaxNode;
  /** Original declaration range. */
  span: GraphSourceSpan;
}

/** One AST model shared by declaration, call, and access extraction. */
export interface LexicalScopeModel {
  /** Explicit supported language; no equivalent capability is inferred for other parsers. */
  language: 'typescript' | 'javascript';
  /** Caller-supplied generation identity for the analyzed source. */
  generation: string;
  /** Publication identity allocated before extraction; absent on standalone source analysis. */
  publicationGeneration?: string;
  /** Lexical scope inventory. */
  scopes: readonly GraphLexicalScope[];
  /** Binding inventory including locals that have no known callable target. */
  bindings: readonly GraphLexicalBinding[];
  /** All nested and object callables/classes, not only module declarations. */
  declarations: readonly LexicalDeclaration[];
  /** Retain an original AST range with explicit UTF-16 offset semantics. */
  spanOf(node: Parser.SyntaxNode): GraphSourceSpan;
  /** Find the innermost scope covering an original UTF-16 offset. */
  scopeAt(offset: number): GraphLexicalScope;
  /** Resolve a visible name without consulting unrelated global declarations. */
  resolve(name: string, offset: number): GraphLexicalResolution;
  /** Identify the actual enclosing declaration, including anonymous callbacks. */
  ownerAt(offset: number): string;
}

const FUNCTIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
const CLASSES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);

function span(node: Parser.SyntaxNode): GraphSourceSpan {
  return {
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    offsetEncoding: 'utf16',
  };
}

function segment(name: string): string {
  return name.replaceAll('%', '%25').replaceAll('.', '%2E').replaceAll(':', '%3A');
}

function propertyName(node: Parser.SyntaxNode | null): string | undefined {
  if (!node || node.type === 'computed_property_name') return undefined;
  if (node.type === 'string')
    return node.namedChildren.find((child) => child.type === 'string_fragment')?.text;
  return node.text;
}

/** Collect only binding patterns, never property keys or type annotation identifiers. */
function patternNames(node: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  if (!node) return [];
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern')
    return [node];
  if (node.type === 'pair_pattern') return patternNames(node.childForFieldName('value'));
  if (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') {
    return patternNames(node.childForFieldName('left') ?? node.namedChild(0));
  }
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    return patternNames(node.childForFieldName('pattern') ?? node.childForFieldName('name'));
  }
  if (
    ['object_pattern', 'array_pattern', 'rest_pattern', 'formal_parameters'].includes(node.type)
  ) {
    return node.namedChildren.flatMap(patternNames);
  }
  return [];
}

/** Property path for object literal methods/callbacks without inventing lexical object scopes. */
function objectPath(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  let current: Parser.SyntaxNode | null = node;
  while (current?.parent) {
    const parent: Parser.SyntaxNode = current.parent;
    if (parent.type === 'pair' && parent.childForFieldName('value')?.id === current.id) {
      const key = propertyName(parent.childForFieldName('key'));
      if (!key) return [];
      names.unshift(segment(key));
    } else if (parent.type === 'variable_declarator') {
      const name = parent.childForFieldName('name');
      if (name?.type === 'identifier') names.unshift(segment(name.text));
      break;
    } else if (parent.type !== 'object' && parent.type !== 'pair') break;
    current = parent;
  }
  return names;
}

/**
 * Build one lexical model over original TypeScript or JavaScript syntax.
 * @param root - Native program node retaining original Unicode and UTF-16 spans.
 * @param filePath - Repository-relative source identity.
 * @param generation - Explicit source generation; required for anonymous identity.
 * @param language - Supported lexical language, never inferred for another grammar.
 * @param publicationGeneration - Optional preallocated publication identity for anonymous symbols.
 * @returns The scope, declaration and binding model shared by reference extractors.
 * @remarks This models lexical bindings, not runtime values, dynamic dispatch or
 * closure invocation. Unknown locals block global fallback. Duplicate nearest
 * bindings return candidates instead of silently choosing the first declaration.
 * @example
 * ```ts
 * const model = buildLexicalScopeModel(tree.rootNode, 'src/auth.ts', sourceHash, 'typescript');
 * const binding = model.resolve('orgNameTaken', call.startIndex);
 * ```
 */
export function buildLexicalScopeModel(
  root: Parser.SyntaxNode,
  filePath: string,
  generation: string,
  language: string,
  publicationGeneration?: string,
): LexicalScopeModel {
  if (language !== 'typescript' && language !== 'javascript')
    throw new Error(`E_SCOPE_LANGUAGE: lexical bindings unsupported for ${language}`);
  if (!generation) throw new Error('Lexical source generation is required');
  if (publicationGeneration === '') throw new Error('Publication generation cannot be empty');
  const moduleId = `${filePath}::__file__`;
  const moduleScope: GraphLexicalScope = {
    id: moduleId,
    kind: 'module',
    ownerId: moduleId,
    span: span(root),
  };
  const scopes = [moduleScope];
  const byId = new Map([[moduleId, moduleScope]]);
  const bindings: GraphLexicalBinding[] = [];
  const declarations: LexicalDeclaration[] = [];
  const scopedBindings = new Map<string, Map<string, GraphLexicalBinding[]>>();

  function addBinding(
    scope: GraphLexicalScope,
    node: Parser.SyntaxNode,
    name: string,
    kind: GraphLexicalBinding['kind'],
    detail: Partial<
      Pick<GraphLexicalBinding, 'targetId' | 'importSource' | 'importedName' | 'typeOnly'>
    > = {},
  ): void {
    const binding: GraphLexicalBinding = {
      id: `${scope.id}::binding:${segment(name)}@${node.startIndex}`,
      name,
      scopeId: scope.id,
      kind,
      span: span(node),
      ...detail,
    };
    bindings.push(binding);
    let names = scopedBindings.get(scope.id);
    if (!names) {
      names = new Map();
      scopedBindings.set(scope.id, names);
    }
    const candidates = names.get(name) ?? [];
    candidates.push(binding);
    names.set(name, candidates);
  }

  function childScope(
    node: Parser.SyntaxNode,
    parent: GraphLexicalScope,
    kind: GraphLexicalScope['kind'],
    ownerId = parent.ownerId,
  ): GraphLexicalScope {
    const scope: GraphLexicalScope = {
      id: `${parent.id}::${kind}@${node.startIndex}:${node.endIndex}`,
      parentId: parent.id,
      kind,
      ownerId,
      span: span(node),
    };
    scopes.push(scope);
    byId.set(scope.id, scope);
    return scope;
  }

  function importBindings(node: Parser.SyntaxNode, scope: GraphLexicalScope): void {
    const rawSource = node.childForFieldName('source')?.text;
    if (!rawSource) return;
    const importSource = rawSource.slice(1, -1);
    const typeOnly = /^import\s+type\b/.test(node.text);
    const clause = node.namedChildren.find((child) => child.type === 'import_clause');
    if (!clause) return;
    for (const child of clause.namedChildren) {
      if (child.type === 'identifier')
        addBinding(scope, child, child.text, 'import', {
          importSource,
          importedName: 'default',
          typeOnly,
        });
      if (child.type === 'namespace_import') {
        const name = child.namedChildren.find((item) => item.type === 'identifier');
        if (name)
          addBinding(scope, name, name.text, 'import', {
            importSource,
            importedName: '*',
            typeOnly,
          });
      }
      if (child.type === 'named_imports')
        for (const specifier of child.namedChildren) {
          const imported = specifier.childForFieldName('name');
          const local = specifier.childForFieldName('alias') ?? imported;
          if (imported && local)
            addBinding(scope, local, local.text, 'import', {
              importSource,
              importedName: imported.text,
              typeOnly: typeOnly || /^type\s/.test(specifier.text),
            });
        }
    }
  }

  function variableOwner(node: Parser.SyntaxNode, scope: GraphLexicalScope): GraphLexicalScope {
    let owner = scope;
    if (node.parent?.type === 'variable_declaration') {
      while (owner.parentId && !['function', 'module'].includes(owner.kind)) {
        const parent = byId.get(owner.parentId);
        if (!parent) throw new Error('Lexical parent scope missing');
        owner = parent;
      }
    }
    return owner;
  }

  function walk(node: Parser.SyntaxNode, scope: GraphLexicalScope): void {
    if (node.type === 'import_statement') {
      importBindings(node, scope);
      return;
    }
    if (FUNCTIONS.has(node.type) || CLASSES.has(node.type)) {
      const isClass = CLASSES.has(node.type);
      const parent = node.parent;
      const declaratorName =
        parent?.type === 'variable_declarator' ? parent.childForFieldName('name') : null;
      const pairName =
        parent?.type === 'pair' ? propertyName(parent.childForFieldName('key')) : undefined;
      const explicitName =
        declaratorName?.type === 'identifier'
          ? declaratorName.text
          : (pairName ?? propertyName(node.childForFieldName('name')));
      const anonymous = !explicitName;
      const name =
        explicitName ??
        `<anonymous@${node.startIndex}:${node.endIndex}#${encodeURIComponent(publicationGeneration ?? generation)}>`;
      const path = objectPath(node);
      if (node.type === 'method_definition') path.push(segment(name));
      const localName = path.length > 0 ? path.join('.') : segment(name);
      const prefix =
        scope.kind === 'module'
          ? `${filePath}::`
          : `${scope.ownerId}.${scope.kind === 'block' || scope.kind === 'catch' ? `block@${scope.span.startIndex}.` : ''}`;
      const id = prefix + localName;
      const property = node.type === 'method_definition' || pairName !== undefined;
      declarations.push({
        id,
        name,
        kind: isClass ? 'class' : property ? 'method' : 'function',
        parentId: scope.ownerId === moduleId ? undefined : scope.ownerId,
        node,
        span: span(node),
      });
      const isDeclaration = node.type.endsWith('_declaration');
      if (!anonymous && !property && (isDeclaration || declaratorName?.type === 'identifier')) {
        addBinding(
          parent?.type === 'variable_declarator' ? variableOwner(parent, scope) : scope,
          declaratorName ?? node.childForFieldName('name') ?? node,
          name,
          isClass ? 'class' : 'function',
          { targetId: id },
        );
      }
      const inner = childScope(node, scope, isClass ? 'class' : 'function', id);
      const internalName = node.childForFieldName('name');
      if (!isDeclaration && internalName?.type === 'identifier' && !property)
        addBinding(inner, internalName, internalName.text, isClass ? 'class' : 'function', {
          targetId: id,
        });
      if (!isClass) {
        const params = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
        for (const parameter of patternNames(params))
          addBinding(inner, parameter, parameter.text, 'parameter');
      }
      for (const child of node.namedChildren) walk(child, inner);
      return;
    }
    if (['for_statement', 'for_in_statement', 'switch_body'].includes(node.type)) {
      const inner = childScope(node, scope, 'block');
      if (node.type === 'for_in_statement' && node.childForFieldName('kind')) {
        let owner = inner;
        if (node.childForFieldName('kind')?.text === 'var') {
          while (owner.parentId && !['function', 'module'].includes(owner.kind)) {
            const parent = byId.get(owner.parentId);
            if (!parent) throw new Error('Lexical parent scope missing');
            owner = parent;
          }
        }
        for (const name of patternNames(node.childForFieldName('left')))
          addBinding(owner, name, name.text, 'local');
      }
      for (const child of node.namedChildren) walk(child, inner);
      return;
    }
    if (node.type === 'statement_block') {
      const isFunctionBody =
        node.parent &&
        FUNCTIONS.has(node.parent.type) &&
        node.parent.childForFieldName('body')?.id === node.id;
      const inner = isFunctionBody ? scope : childScope(node, scope, 'block');
      for (const child of node.namedChildren) walk(child, inner);
      return;
    }
    if (node.type === 'catch_clause') {
      const inner = childScope(node, scope, 'catch');
      for (const name of patternNames(node.childForFieldName('parameter')))
        addBinding(inner, name, name.text, 'catch');
      for (const child of node.namedChildren) walk(child, inner);
      return;
    }
    if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      const pattern = node.childForFieldName('name');
      if (
        !(
          pattern?.type === 'identifier' &&
          value &&
          (FUNCTIONS.has(value.type) || CLASSES.has(value.type))
        )
      ) {
        const owner = variableOwner(node, scope);
        for (const name of patternNames(pattern)) addBinding(owner, name, name.text, 'local');
      }
    }
    for (const child of node.namedChildren) walk(child, scope);
  }
  for (const child of root.namedChildren) walk(child, moduleScope);

  function scopeAt(offset: number): GraphLexicalScope {
    let selected = moduleScope;
    for (const scope of scopes)
      if (
        offset >= scope.span.startIndex &&
        offset < scope.span.endIndex &&
        scope.span.endIndex - scope.span.startIndex <=
          selected.span.endIndex - selected.span.startIndex
      )
        selected = scope;
    return selected;
  }
  function resolve(name: string, offset: number): GraphLexicalResolution {
    let scope: GraphLexicalScope | undefined = scopeAt(offset);
    while (scope) {
      const found = scopedBindings.get(scope.id)?.get(name);
      if (found?.length) {
        if (found.length > 1)
          return {
            kind: 'ambiguous',
            bindings: found,
            reason: 'Multiple bindings in the nearest lexical scope',
          };
        const binding = found[0];
        if (binding.typeOnly)
          return {
            kind: 'shadowed',
            bindings: found,
            reason: 'Type-only binding cannot supply a runtime value',
          };
        if (binding.kind === 'import')
          return {
            kind: 'import',
            bindings: found,
            reason: 'Explicit lexical import requires source-module resolution',
          };
        if (binding.targetId)
          return {
            kind: 'resolved',
            bindings: found,
            reason: 'Lexical declaration establishes the callable or class identity',
          };
        return {
          kind: 'shadowed',
          bindings: found,
          reason: `Nearest ${binding.kind} binding has no statically established callable target`,
        };
      }
      scope = scope.parentId ? byId.get(scope.parentId) : undefined;
    }
    return {
      kind: 'unbound',
      bindings: [],
      reason: 'No lexical or imported binding; global names are candidates only',
    };
  }
  return {
    language,
    generation,
    publicationGeneration,
    scopes,
    bindings,
    declarations,
    spanOf: span,
    scopeAt,
    resolve,
    ownerAt: (offset) => scopeAt(offset).ownerId,
  };
}
