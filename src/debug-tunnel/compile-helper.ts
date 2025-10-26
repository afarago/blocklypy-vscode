/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { parser as rawParser } from '@lezer/python';
import Config, { FeatureFlags } from '../extension/config';
import { compiledModules, CompileModule } from '../logic/compile';

const DEBUG_MODULE_NAME = 'dap_aipp_full'; // name of the module to import in user code - file name without .py
// export const DEBUG_MODULE_NAME = 'dap_aipp_min'; // name of the module to import in user code - file name without .py
export const DEBUG_ASSET_MODULES = [DEBUG_MODULE_NAME];
const DEBUG_TRAP_FUNCTION = 'dt_trap';
// Quick stmt keyword test used both for analysis and for skipping trap insertion
const STATEMENT_KEYWORD_RE =
    /^\s*(#|(async\s+)?(def|class|for|while|if|elif|else|import|from|global|nonlocal|type))\b/;
const MAX_TRAP_VARIABLES = 255;

export function PybricksDebugEnabled() {
    return Config.FeatureFlag.get(
        FeatureFlags.PybricksUseApplicationInterfaceForPybricksProtocol,
    );
}

function canHaveBreakpoint(_path: string, _lineno: number, line: string) {
    // check if lines is empty or line starts with a comment
    return line.trim().length > 0 && !line.trim().startsWith('#');
}

export function checkLineForBreakpoint(path: string, lineno: number, _line: string) {
    return !!compiledModules?.get(path)?.breakpoints?.includes(lineno);
}

/**
 * Analyze the whole module once to:
 *  - Track simple variable definitions (assignments, not attributes/imports/defs)
 *  - Collect, per line, variable references that refer to variables defined earlier
 *    in the same scope (function/class) or an outer scope.
 *  - Exclude first definition occurrences on their defining line.
 */
function analyzeVariablesWholeFile(source: string): {
    refsPerLine: string[][]; // variables to expose per 1-based line
    definedBeforeLine: Set<string>[]; // debugging: cumulative (global) definitions per line
} {
    const tree = rawParser.parse(source);
    const lines = source.split('\n');
    const lineStarts: number[] = [];
    let pos = 0;
    for (const l of lines) {
        lineStarts.push(pos);
        pos += l.length + 1; // +1 for '\n'
    }
    function offsetToLine(off: number): number {
        // binary search
        let lo = 0,
            hi = lineStarts.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const start = lineStarts[mid];
            const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Infinity;
            if (off < start) hi = mid - 1;
            else if (off >= next) lo = mid + 1;
            else return mid + 1; // 1-based
        }
        return lineStarts.length;
    }

    const refsPerLine: Array<Set<string>> = lines.map(() => new Set<string>());
    const definedBeforeLine: Set<string>[] = lines.map(() => new Set<string>());

    // Scope stack: each scope has a set of defined names
    interface Scope {
        names: Set<string>;
    }
    const scopeStack: Scope[] = [{ names: new Set<string>() }];

    function currentScope() {
        return scopeStack[scopeStack.length - 1];
    }

    function isCallee(sn: any): boolean {
        const parent = sn.parent;
        if (!parent) return false;
        if (parent.type.name === 'CallExpression') {
            const callee = parent.firstChild;
            return !!callee && sn.from >= callee.from && sn.to <= callee.to;
        }
        return false;
    }
    function hasAncestor(sn: any, names: string[]): boolean {
        let p = sn.parent;
        while (p) {
            if (names.includes(p.type.name)) return true;
            if (p.type.name === 'Module' || p.type.name.endsWith('Statement')) break;
            p = p.parent;
        }
        return false;
    }
    function isAttributePart(sn: any): boolean {
        let p = sn.parent;
        while (p) {
            if (p.type.name === 'AttributeExpression') return true;
            if (p.type.name === 'CallExpression') return false;
            if (p.type.name === 'Module' || p.type.name.endsWith('Statement'))
                return false;
            p = p.parent;
        }
        return false;
    }
    function isDefinitionName(sn: any): boolean {
        const parent = sn.parent;
        if (!parent) return false;
        if (
            parent.type.name === 'FunctionDefinition' ||
            parent.type.name === 'ClassDefinition'
        ) {
            const firstVar = parent.getChild('VariableName');
            return !!firstVar && firstVar.from === sn.from && firstVar.to === sn.to;
        }
        if (parent.type.name.includes('Param') || parent.type.name === 'Parameters')
            return true;
        if (parent.type.name.includes('Pattern')) return true;
        return false;
    }
    function isImportName(sn: any): boolean {
        return hasAncestor(sn, ['ImportStatement', 'ImportFrom']);
    }
    // Very lightweight assignment target heuristic: variable before first '=' in its statement
    function isAssignmentTarget(sn: any): boolean {
        if (isAttributePart(sn)) return false;
        // Find statement boundary to slice text
        let stmt = sn;
        while (
            stmt.parent &&
            !stmt.type.name.endsWith('Statement') &&
            stmt.type.name !== 'Module'
        ) {
            stmt = stmt.parent;
        }
        const slice = source.slice(stmt.from, stmt.to);
        // Find a single '=' not part of ==, !=, <=, >=, := inside this statement
        let eqOffsetInStmt = -1;
        for (let i = 0; i < slice.length; i++) {
            if (slice[i] === '=') {
                const prev = slice[i - 1] ?? '';
                const next = slice[i + 1] ?? '';
                if (
                    prev !== '=' &&
                    prev !== '!' &&
                    prev !== '<' &&
                    prev !== '>' &&
                    prev !== ':' &&
                    next !== '='
                ) {
                    eqOffsetInStmt = i;
                    break;
                }
            }
        }
        if (eqOffsetInStmt < 0) return false;
        // sn must end before '='
        return sn.to <= stmt.from + eqOffsetInStmt;
    }

    // Track first definition on its line so we can exclude it from refs that same line
    const lineFirstDefinitions = new Map<number, Set<string>>();

    // function hasAncestorAnywhere(node: any, names: string[]): boolean {
    //     let p = node.parent;
    //     while (p) {
    //         if (names.includes(p.type.name)) return true;
    //         p = p.parent;
    //     }
    //     return false;
    // }

    function hasParent(node: any, names: string[]): boolean {
        let p = node.parent;
        if (names.includes(p.type.name)) return true;
        return false;
    }

    tree.iterate({
        enter(node) {
            const type = node.type.name;

            // Push scope for function/class
            if (type === 'FunctionDefinition' || type === 'ClassDefinition') {
                scopeStack.push({ names: new Set<string>() });
            }

            if (type !== 'VariableName') return;

            const sn = node.node;
            if (!sn) return;
            const lineNo = offsetToLine(sn.from);
            const name = source.slice(sn.from, sn.to);

            // Quick heuristic: if the line itself starts with a compound/non-simple
            // statement or one of the keywords we want to skip (import/scope/type),
            // ignore variables on that line. This avoids walking lots of AST ancestors.
            // (We already excluded variables inside function/class/for/while above.)
            const lineText = lines[lineNo - 1] ?? '';
            if (STATEMENT_KEYWORD_RE.test(lineText)) return;

            // 1) If the variable is inside a function/class/for/while, skip entirely
            if (
                // hasAncestorAnywhere(sn, [
                //     'FunctionDefinition',
                //     'ClassDefinition',
                //     'ForStatement',
                //     'WhileStatement',
                //     'StatementGroup',
                // ]) ||
                hasParent(sn, ['CallExpression'])
            ) {
                return;
            }

            // Skip other unwanted categories
            if (
                isCallee(sn) ||
                isAttributePart(sn) ||
                isDefinitionName(sn) ||
                isImportName(sn)
            ) {
                return;
            }

            // Assignment target? Define it (but not referenced on same line)
            if (isAssignmentTarget(sn)) {
                currentScope().names.add(name);
                if (!lineFirstDefinitions.has(lineNo))
                    lineFirstDefinitions.set(lineNo, new Set());
                lineFirstDefinitions.get(lineNo)!.add(name);
                return;
            }

            // Reference: include only if already defined in some scope (prior to this point)
            // Check scopes from inner to outer
            let defined = false;
            for (let i = scopeStack.length - 1; i >= 0 && !defined; i--) {
                if (scopeStack[i].names.has(name)) defined = true;
            }
            if (!defined) return;

            // Exclude if first defined on this same line
            if (lineFirstDefinitions.get(lineNo)?.has(name)) return;

            refsPerLine[lineNo - 1].add(name);
        },
        leave(node) {
            const type = node.type.name;
            if (type === 'FunctionDefinition' || type === 'ClassDefinition') {
                scopeStack.pop();
            }
        },
    });

    // Build cumulative (global) definitions per line (optional diagnostics)
    const cumulative = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
        if (lineFirstDefinitions.has(i + 1)) {
            for (const n of lineFirstDefinitions.get(i + 1)!) cumulative.add(n);
        }
        definedBeforeLine[i] = new Set(cumulative);
    }

    return {
        refsPerLine: refsPerLine.map((s) => Array.from(s)),
        definedBeforeLine,
    };
}

export function transformCodeForDebugTunnel(
    module: CompileModule,
    breakpointsInput: number[] = [],
) {
    const analysis = analyzeVariablesWholeFile(module.content);
    const refsPerLine = analysis.refsPerLine;

    const lines = module.content.split('\n');
    const linesOut: string[] = [];
    const breakpointsCompiled = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const lineno1 = i + 1;

        // If the line starts with a compound/skip keyword, leave it untouched
        // and do not add any debug trap here.
        if (STATEMENT_KEYWORD_RE.test(line)) {
            linesOut.push(line);
            continue;
        }

        // If there are variable references to expose, or if the line is a user-set
        // breakpoint, add a debug trap call at the start of the line.
        // example:
        //    [i,j] = dap_aipp_full.dt_trap('simple1.py', 4, i=i, j=j); print(i,j)
        //    dap_aipp_full.dt_trap('simple1.py', 5)
        if (
            checkLineForBreakpoint(module.path, lineno1, line) ||
            (breakpointsInput.includes(lineno1) &&
                canHaveBreakpoint(module.path, lineno1, line))
        ) {
            const indentation = line.match(/^\s*/)?.[0] ?? '';
            const vars = refsPerLine[lineno1 - 1].slice(0, MAX_TRAP_VARIABLES);

            // e.g. import dap_aipp_full; [i,s,v2,x] = dap_aipp_full.dt_trap('simple1.py', 33, ['i', 's', 'v2', 'x'], [i, s, v2, x]); print(i,s,v2,x)
            // return values as list [i, j] = ...
            const varspre = vars.length ? `[${vars.join(',')}] = ` : '';
            // exposed keys and values as two lists
            const varnames = `[${vars.map((v) => `'${v}'`).join(', ')}]`;
            const varvalues = `[${vars.map((v) => `${v}`).join(', ')}]`;
            const line_pre = `import ${DEBUG_MODULE_NAME}; ${varspre}${DEBUG_MODULE_NAME}.${DEBUG_TRAP_FUNCTION}('${module.filename}', ${lineno1}, ${varnames}, ${varvalues})`;
            line = `${indentation}${line_pre}; ${line.trimStart()}`;

            breakpointsCompiled.add(lineno1);
            if (!breakpointsInput.includes(lineno1)) breakpointsInput.push(lineno1);
        }
        linesOut.push(line);
    }

    module.content = linesOut.join('\n');
    module.breakpoints = Array.from(breakpointsCompiled).sort((a, b) => a - b);

    // if (isDevelopmentMode && module.breakpoints.length > 0) {
    //     console.log(module.content);
    // }
}
