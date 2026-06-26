/**
 * AssistantPanel.tsx
 *
 * FlightDrama AI Assistant — a floating chat panel that lives in the bottom-right
 * corner of every page. Powered by Groq (Llama 3.3 70B), it knows everything
 * about the FlightDrama site and can take real actions through conversation.
 */

import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MessageCircle, X, Send, Loader2, Bot, User, Trash2, Minimize2 } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

const WELCOME_MESSAGE: Message = {
  role: "assistant",
  content: `Hey! I'm your FlightDrama AI assistant. I know everything about your site — stories, scores, RSS feeds, pipeline, performance data — and I can take real actions.\n\nTry asking me:\n• "What's in my queue right now?"\n• "Why did story 42 score so low?"\n• "Rewrite the article on story 15 — make it punchier"\n• "Which RSS feeds haven't fetched recently?"\n• "Update the scoring rules to prioritise Boeing stories"`,
  timestamp: new Date(),
};

export default function AssistantPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimised, setIsMinimised] = useState(false);
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const chat = trpc.assistant.chat.useMutation({
    onSuccess: (data) => {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: data.reply,
        timestamp: new Date(),
      }]);
      setIsThinking(false);
    },
    onError: (err) => {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `Sorry, I hit an error: ${err.message}. Please try again.`,
        timestamp: new Date(),
      }]);
      setIsThinking(false);
    },
  });

  useEffect(() => {
    if (isOpen && !isMinimised) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen, isMinimised]);

  useEffect(() => {
    if (isOpen && !isMinimised) {
      textareaRef.current?.focus();
    }
  }, [isOpen, isMinimised]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text || isThinking) return;

    const userMessage: Message = {
      role: "user",
      content: text,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsThinking(true);

    // Build history (exclude welcome message, last 10 exchanges)
    const history = messages
      .filter(m => m !== WELCOME_MESSAGE)
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));

    chat.mutate({ message: text, history });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([WELCOME_MESSAGE]);
  };

  const formatContent = (content: string) => {
    // Simple formatting: bold **text**, bullet points, line breaks
    return content.split("\n").map((line, i) => {
      const formatted = line
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-xs font-mono">$1</code>');
      if (line.startsWith("• ") || line.startsWith("- ")) {
        return <li key={i} className="ml-3 list-disc" dangerouslySetInnerHTML={{ __html: formatted.slice(2) }} />;
      }
      return <p key={i} dangerouslySetInnerHTML={{ __html: formatted || "&nbsp;" }} />;
    });
  };

  return (
    <>
      {/* Floating trigger button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-20 right-4 lg:bottom-6 lg:right-6 z-50 w-14 h-14 rounded-full bg-yellow-500 hover:bg-yellow-400 text-black shadow-lg flex items-center justify-center transition-all hover:scale-105 active:scale-95"
          title="Open FlightDrama AI Assistant"
        >
          <Bot className="w-6 h-6" />
        </button>
      )}

      {/* Chat panel */}
      {isOpen && (
        <div
          className={cn(
            "fixed z-50 flex flex-col bg-background border border-border/60 shadow-2xl transition-all duration-200",
            // Mobile: full screen panel from bottom
            "bottom-0 left-0 right-0 lg:bottom-6 lg:left-auto lg:right-6",
            "rounded-t-2xl lg:rounded-2xl",
            isMinimised
              ? "h-14 lg:w-72"
              : "h-[85vh] lg:h-[560px] lg:w-[380px]"
          )}
        >
          {/* Header */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/60 bg-yellow-500/10 rounded-t-2xl">
            <div className="w-7 h-7 rounded-full bg-yellow-500 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 text-black" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-none">FlightDrama AI</p>
              {!isMinimised && (
                <p className="text-xs text-muted-foreground mt-0.5">Powered by Groq · Llama 3.3 70B</p>
              )}
            </div>
            <div className="flex items-center gap-1">
              {!isMinimised && (
                <button
                  onClick={clearChat}
                  className="p-1.5 rounded-lg hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
                  title="Clear conversation"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setIsMinimised(!isMinimised)}
                className="p-1.5 rounded-lg hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
                title={isMinimised ? "Expand" : "Minimise"}
              >
                <Minimize2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
                title="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {!isMinimised && (
            <>
              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex gap-2.5",
                      msg.role === "user" ? "flex-row-reverse" : "flex-row"
                    )}
                  >
                    {/* Avatar */}
                    <div className={cn(
                      "w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
                      msg.role === "assistant"
                        ? "bg-yellow-500/20 text-yellow-500"
                        : "bg-primary/20 text-primary"
                    )}>
                      {msg.role === "assistant"
                        ? <Bot className="w-3.5 h-3.5" />
                        : <User className="w-3.5 h-3.5" />
                      }
                    </div>

                    {/* Bubble */}
                    <div className={cn(
                      "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed space-y-1",
                      msg.role === "assistant"
                        ? "bg-muted/50 text-foreground rounded-tl-sm"
                        : "bg-primary text-primary-foreground rounded-tr-sm"
                    )}>
                      {formatContent(msg.content)}
                    </div>
                  </div>
                ))}

                {/* Thinking indicator */}
                {isThinking && (
                  <div className="flex gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-yellow-500/20 text-yellow-500 flex items-center justify-center flex-shrink-0">
                      <Bot className="w-3.5 h-3.5" />
                    </div>
                    <div className="bg-muted/50 rounded-2xl rounded-tl-sm px-3.5 py-3 flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="p-3 border-t border-border/60">
                <div className="flex gap-2 items-end">
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask me anything about your site..."
                    className="flex-1 min-h-[40px] max-h-[120px] resize-none text-sm bg-muted/30 border-border/60 rounded-xl py-2.5 px-3 leading-relaxed"
                    disabled={isThinking}
                    rows={1}
                  />
                  <Button
                    size="icon"
                    className="h-10 w-10 rounded-xl bg-yellow-500 hover:bg-yellow-400 text-black flex-shrink-0"
                    onClick={sendMessage}
                    disabled={!input.trim() || isThinking}
                  >
                    {isThinking
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <Send className="w-4 h-4" />
                    }
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground/60 mt-1.5 text-center">
                  Press Enter to send · Shift+Enter for new line
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
