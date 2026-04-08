import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownBody({
  text,
  muted = false,
}: {
  text: string;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "markdown-body text-sm leading-6 text-muted-foreground" : "markdown-body text-sm leading-6"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { children, className } = props;
            const inline = !className;
            if (inline) {
              return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{children}</code>;
            }
            return (
              <pre className="overflow-auto rounded-md border border-border bg-background/70 p-3">
                <code className={className}>{children}</code>
              </pre>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
