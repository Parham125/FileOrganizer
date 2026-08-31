import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke, isDesktop } from "../bridge";

// Assistant replies are model output, so raw HTML is never rendered: no
// rehype-raw, no dangerouslySetInnerHTML. react-markdown drops HTML nodes and
// strips javascript: URLs on its own, which is exactly what we want here.

function openLink(href: string) {
  if (isDesktop) void invoke("open_file", { path: href }).catch(() => {});
  else window.open(href, "_blank", "noopener,noreferrer");
}

const COMPONENTS = {
  p: (p: object) => (
    <p className="my-2 leading-[1.62] first:mt-0 last:mb-0" {...p} />
  ),
  h1: (p: object) => (
    <h2
      className="mt-4 mb-1.5 text-[15px] font-semibold tracking-[-0.01em] first:mt-0"
      {...p}
    />
  ),
  h2: (p: object) => (
    <h3
      className="mt-4 mb-1.5 text-sm font-semibold tracking-[-0.01em] first:mt-0"
      {...p}
    />
  ),
  h3: (p: object) => (
    <h4
      className="mt-3.5 mb-1 text-sm font-medium text-ink first:mt-0"
      {...p}
    />
  ),
  h4: (p: object) => (
    <h5
      className="mt-3 mb-1 text-xs font-semibold text-ink-soft first:mt-0"
      {...p}
    />
  ),
  ul: (p: object) => (
    <ul
      className="my-2 list-disc space-y-1 pl-5 marker:text-ink-faint first:mt-0 last:mb-0 [&_li:has(>input)]:list-none [&_li:has(>input)]:-ml-5"
      {...p}
    />
  ),
  ol: (p: object) => (
    <ol
      className="my-2 list-decimal space-y-1 pl-5 marker:text-ink-faint marker:tabular-nums first:mt-0 last:mb-0"
      {...p}
    />
  ),
  li: (p: object) => (
    <li className="leading-[1.55] [&>ul]:my-1 [&>ol]:my-1" {...p} />
  ),
  input: (p: { type?: string; checked?: boolean }) =>
    p.type === "checkbox" ? (
      <input
        type="checkbox"
        checked={!!p.checked}
        readOnly
        disabled
        className="mr-2 h-3 w-3 translate-y-[1px] accent-[var(--teal)]"
      />
    ) : null,
  a: (p: { href?: string; children?: React.ReactNode }) => (
    <a
      href={p.href ?? "#"}
      onClick={(e) => {
        e.preventDefault();
        if (p.href) openLink(p.href);
      }}
      className="text-teal underline decoration-teal-line underline-offset-2 hover:decoration-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
    >
      {p.children}
    </a>
  ),
  code: (p: object) => (
    <code
      className="rounded-[3px] bg-teal-soft px-[0.35em] py-[0.12em] font-mono text-[0.86em] text-teal [overflow-wrap:anywhere]"
      {...p}
    />
  ),
  pre: (p: object) => (
    <pre
      className="my-2.5 overflow-x-auto rounded-md border border-line bg-surface p-3 font-mono text-xs leading-[1.55] text-ink first:mt-0 last:mb-0 [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[inherit] [&>code]:text-ink"
      {...p}
    />
  ),
  blockquote: (p: object) => (
    <blockquote
      className="my-2.5 border-l-2 border-teal-line pl-3 text-ink-soft first:mt-0 last:mb-0"
      {...p}
    />
  ),
  hr: () => <hr className="my-3 border-0 border-t border-line" />,
  table: (p: object) => (
    <div className="my-2.5 overflow-x-auto rounded-md border border-line first:mt-0 last:mb-0">
      <table
        className="w-full border-collapse text-xs [&_tr:last-child>td]:border-b-0"
        {...p}
      />
    </div>
  ),
  th: (p: object) => (
    <th
      className="whitespace-nowrap border-b border-line bg-surface px-2.5 py-1.5 text-left font-medium text-ink-soft"
      {...p}
    />
  ),
  td: (p: object) => (
    <td
      className="whitespace-nowrap border-b border-line px-2.5 py-1.5 align-top"
      {...p}
    />
  ),
  img: (p: { alt?: string }) => (
    <span className="text-xs text-ink-faint">{p.alt || "Image"}</span>
  ),
};

// Assistant text arrives a fragment at a time, so this renders partial markdown
// (an unclosed fence, a half-written list) on every keystroke of the stream.
function Markdown({ text }: { text: string }) {
  return (
    <div className="fo-md text-sm text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
