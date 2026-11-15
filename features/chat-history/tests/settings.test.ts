import assert from "node:assert/strict";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeSettings from "../server/settings";
import { defaultPreferences, preferences, preferencesSchema } from "../shared/settings";

test("display settings have bounded defaults and reject invalid documents", () => {
  assert.deepEqual(defaultPreferences, { defaultExpanded: false, previewLength: 1800, pageSize: 40 });
  assert.deepEqual(preferencesSchema.parse({}), defaultPreferences);
  for (const previewLength of [0, 1, 20000]) {
    assert.equal(preferencesSchema.parse({ previewLength }).previewLength, previewLength);
  }
  for (const pageSize of [10, 200]) assert.equal(preferencesSchema.parse({ pageSize }).pageSize, pageSize);
  for (const value of [{ defaultExpanded: "yes" }, { previewLength: -1 }, { previewLength: 20001 }, { previewLength: 1.2 },
    { pageSize: 9 }, { pageSize: 201 }, { pageSize: 40.5 }, { pageSize: "40" }, null]) {
    assert.equal(preferencesSchema.safeParse(value).success, false);
  }
});

test("always-active server contribution registers only feature-owned host settings", () => {
  const registrations: unknown[] = [];
  const stop = contributeSettings({ registerSettings(definition: unknown) { registrations.push(definition); } } as unknown as PluginServerContext);
  assert.deepEqual(registrations, [preferences]);
  assert.equal(preferences.id, "chat-history-preferences");
  assert.equal(preferences.scope, "host");
  assert.equal(preferences.version, 1);
  assert.doesNotThrow(stop);
  assert.doesNotThrow(stop);
});
