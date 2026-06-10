import ReactMarkdown from "react-markdown";

/**
 * Lightweight markdown renderer — replaces streamdown (which bundles KaTeX,
 * adding ~11 MB to the production bundle unnecessarily).
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none leading-relaxed">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
