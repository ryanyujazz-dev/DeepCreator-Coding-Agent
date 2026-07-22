import { ToolState } from "../../shared/contracts/runtime";

/** Removes legacy UI projection hints before a ToolState enters the Event journal. */
export function durableToolState(tool: ToolState | undefined): ToolState | undefined {
  if (!tool) return undefined;
  const { detail: _detail, displayTarget: _displayTarget, groupMode: _groupMode, importance: _importance, ...facts } = tool;
  return facts;
}
