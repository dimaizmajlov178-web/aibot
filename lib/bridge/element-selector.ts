const STABLE_SELECTOR_ATTRIBUTES = [
  "data-testid",
  "data-test-id",
  "data-qa",
  "data-cy",
  "data-slot",
] as const;

function escapeCssIdentifier(value: string): string {
  return typeof CSS === "undefined" ? value : CSS.escape(value);
}

export function computeSelector(element: Element, root: Element = document.body): string {
  if (element.id) return `#${element.id}`;

  const path: string[] = [];
  let current: Element | null = element;

  while (current && current !== root) {
    let selector = current.tagName.toLowerCase();
    const classes = Array.from(current.classList).filter(
      (className) => className.trim() && !className.startsWith("hover-")
    );
    if (classes.length) {
      selector += `.${classes.join(".")}`;
    }

    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (sibling) => sibling.tagName === current!.tagName
        )
      : [];
    if (siblings.length > 1) {
      const index = siblings.indexOf(current) + 1;
      selector += `:nth-of-type(${index})`;
    }

    path.unshift(selector);
    current = current.parentElement;
  }

  return path.join(" > ");
}

export function computeDisplaySelector(element: Element, selector: string): string {
  const tagName = element.tagName.toLowerCase();

  if (element.id) {
    return `${tagName}#${escapeCssIdentifier(element.id)}`;
  }

  for (const attributeName of STABLE_SELECTOR_ATTRIBUTES) {
    if (element.hasAttribute(attributeName)) {
      const attributeValue = element.getAttribute(attributeName);
      return attributeValue
        ? `${tagName}[${attributeName}="${escapeCssIdentifier(attributeValue)}"]`
        : `${tagName}[${attributeName}]`;
    }
  }

  const childCombinatorIndex = selector.lastIndexOf(" > ");
  return childCombinatorIndex === -1
    ? selector
    : selector.slice(childCombinatorIndex + 3).trim();
}

export function computeXPath(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current) {
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    segments.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }

  return "/" + segments.join("/");
}
