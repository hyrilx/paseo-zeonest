import assert from "node:assert/strict";
import { act, type ReactTestRenderer } from "react-test-renderer";

export function button(root: ReactTestRenderer, label: string) {
  const node = root.root.findAll((node) => String(node.type) === "Pressable" && node.props.accessibilityLabel === label)[0];
  assert.ok(node, "Missing button: " + label);
  return node;
}
export function picker(root: ReactTestRenderer, label: string) {
  const node = root.root.findAll((node) => node.props.label === label && Array.isArray(node.props.options))[0];
  assert.ok(node, "Missing picker: " + label);
  return node;
}
export async function pick(root: ReactTestRenderer, label: string, value: string) {
  await act(async () => button(root, label).props.onPress());
  const option = root.root.findAll((node) => String(node.type) === "Pressable" && node.props.testID === "file-activity-option-" + value)[0];
  assert.ok(option, "Missing option: " + value);
  await act(async () => option.props.onPress());
}
