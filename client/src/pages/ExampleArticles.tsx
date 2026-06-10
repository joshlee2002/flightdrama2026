import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Trash2, Plus, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import FlightLayout from "@/components/FlightLayout";

export default function ExampleArticles() {
  const [label, setLabel] = useState("");
  const [articleText, setArticleText] = useState("");

  const utils = trpc.useUtils();
  const { data: examples = [], isLoading } = trpc.exampleArticles.list.useQuery();

  const addMutation = trpc.exampleArticles.add.useMutation({
    onSuccess: () => {
      utils.exampleArticles.list.invalidate();
      setLabel("");
      setArticleText("");
      toast.success("Example article saved.");
    },
    onError: (err) => toast.error(err.message),
  });

  const removeMutation = trpc.exampleArticles.remove.useMutation({
    onSuccess: () => {
      utils.exampleArticles.list.invalidate();
      toast.success("Example article removed.");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleAdd = () => {
    if (!label.trim()) { toast.error("Please add a label for this example."); return; }
    if (articleText.trim().length < 10) { toast.error("Article text is too short."); return; }
    addMutation.mutate({ label: label.trim(), articleText: articleText.trim() });
  };

  return (
    <FlightLayout>
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Example Articles</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Paste real FlightDrama articles here. The Soyunci pipeline will use up to 3 of these as voice references when writing new articles, so it matches your style exactly.
          </p>
        </div>

        {/* Add new example */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader>
            <CardTitle className="text-base text-white">Add an example article</CardTitle>
            <CardDescription className="text-zinc-400 text-sm">
              Paste a published FlightDrama article you're happy with. Give it a short label so you can identify it later.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1 block">Label</label>
              <Input
                placeholder="e.g. Southwest 737 MAX grounding"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="bg-zinc-800 border-zinc-700 text-white placeholder:text-zinc-500"
                maxLength={256}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1 block">Article text</label>
              <Textarea
                placeholder="Paste the full article text here..."
                value={articleText}
                onChange={(e) => setArticleText(e.target.value)}
                className="bg-zinc-800 border-zinc-700 text-white placeholder:text-zinc-500 min-h-[200px] resize-y font-mono text-sm"
              />
              <p className="text-xs text-zinc-500 mt-1">{articleText.length} characters</p>
            </div>
            <Button
              onClick={handleAdd}
              disabled={addMutation.isPending || !label.trim() || articleText.trim().length < 10}
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              {addMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</>
              ) : (
                <><Plus className="w-4 h-4 mr-2" /> Save example</>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Existing examples */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">
            Saved examples ({examples.length})
          </h2>

          {isLoading && (
            <div className="flex items-center gap-2 text-zinc-500 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          )}

          {!isLoading && examples.length === 0 && (
            <div className="text-zinc-500 text-sm py-6 text-center border border-dashed border-zinc-700 rounded-lg">
              No example articles saved yet. Add one above to improve article quality.
            </div>
          )}

          {examples.map((ex) => (
            <Card key={ex.id} className="bg-zinc-900 border-zinc-800">
              <CardContent className="pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <FileText className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">{ex.label}</p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {ex.articleText.length} characters &middot; Added {new Date(ex.createdAt).toLocaleDateString()}
                      </p>
                      <p className="text-xs text-zinc-400 mt-2 line-clamp-3 font-mono leading-relaxed">
                        {ex.articleText.slice(0, 300)}{ex.articleText.length > 300 ? "…" : ""}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-zinc-500 hover:text-red-400 hover:bg-red-950/30 shrink-0"
                    onClick={() => removeMutation.mutate({ id: ex.id })}
                    disabled={removeMutation.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </FlightLayout>
  );
}
