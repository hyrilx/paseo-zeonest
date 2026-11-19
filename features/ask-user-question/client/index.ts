import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QuestionnaireRenderer } from "./questionnaire";
import { questionnaireTransformer } from "./transform";
import { timelineSchema } from "../shared/contracts";

export default function contribute(client: PluginClientContext) {
  const removeRenderer = client.addTimelineRenderer({
    kind: "ask-user-question",
    version: 1,
    schema: timelineSchema,
    Component: QuestionnaireRenderer,
  });
  let removeTransformer: () => void;
  try {
    removeTransformer = client.addTimelineTransformer(questionnaireTransformer);
  } catch (error) {
    removeRenderer();
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    try { removeTransformer(); }
    finally { removeRenderer(); }
  };
}
