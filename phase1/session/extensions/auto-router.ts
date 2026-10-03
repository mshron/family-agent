// The `auto` virtual model: GLM-5.3-flash by default, a strong model at
// thinking level "high". Tool follow-ups and retries stay on the physical
// model that handled the turn, so prompt caches and thinking signatures
// stay valid (see docs/memos/hetzner-consolidation.md, Model routing).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["low", "high"],
    route(request, ctx) {
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return {
          model: sticky.model,
          thinkingLevel: sticky.thinkingLevel ?? "medium",
        };
      }
      const strong = request.thinkingLevel === "high";
      const id = strong ? "z-ai/glm-5.3" : "z-ai/glm-5.3-flash";
      const model = ctx.modelRegistry.find("openrouter", id);
      if (!model) {
        throw new Error(`Model not found in openrouter catalog: ${id}`);
      }
      return { model, thinkingLevel: strong ? "high" : "low" };
    },
  });
}
