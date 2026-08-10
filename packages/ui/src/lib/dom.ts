/**
 * Minimal typed DOM helpers.
 *
 * The previous UI carried AngularJS, jQuery, jQuery UI and Bootstrap's JS to
 * do what amounts to element creation, event binding and list rendering. These
 * few functions cover the same ground with no runtime dependency.
 */

type Child = Node | string | number | false | null | undefined;

type Attrs<K extends keyof HTMLElementTagNameMap> = {
  class?: string;
  text?: string;
  html?: string;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
} & Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset' | 'children'>> & {
    // Hyphenated names are attributes, not properties; see the note in h().
    [key: `aria-${string}`]: string | undefined;
  } & { role?: string };

/**
 * Create an element.
 *
 * Falsy children are skipped so `cond && h(...)` reads naturally.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    switch (key) {
      case 'class':
        el.className = value as string;
        break;
      case 'text':
        el.textContent = String(value);
        break;
      case 'html':
        // Only ever used with trusted translated markup.
        el.innerHTML = value as string;
        break;
      case 'dataset':
        Object.assign(el.dataset, value);
        break;
      case 'style':
        Object.assign(el.style, value);
        break;
      default:
        if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (key.includes('-')) {
          // aria-* / data-* have no matching IDL property, so assigning them
          // would silently create a plain JS property and the attribute
          // selectors that style them would never match.
          el.setAttribute(key, String(value));
        } else {
          (el as unknown as Record<string, unknown>)[key] = value;
        }
    }
  }

  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Query a single element, throwing when it is missing rather than returning null. */
export function must<E extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): E {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
}

export function all<E extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): E[] {
  return Array.from(root.querySelectorAll<E>(selector));
}

/** Replace an element's children in one operation. */
export function render(parent: Element, children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/**
 * Delegated event binding.
 *
 * Lets list containers be rendered wholesale without rebinding handlers per
 * row.
 */
export function on<K extends keyof HTMLElementEventMap>(
  root: Element | Document,
  type: K,
  selector: string,
  handler: (event: HTMLElementEventMap[K], target: HTMLElement) => void,
): void {
  root.addEventListener(type, (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>(selector);
    if (target && root.contains(target)) {
      handler(event as HTMLElementEventMap[K], target);
    }
  });
}

/** Trigger a file download from in-memory content. */
export function downloadFile(filename: string, content: BlobPart, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = h('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
