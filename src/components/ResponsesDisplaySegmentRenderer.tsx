import { ComponentProps } from "react";
import { DisplaySegmentRenderer } from "./DisplaySegmentRenderer";

/** Protocol-specific renderer boundary for semantic Responses display state. */
export function ResponsesDisplaySegmentRenderer(props: ComponentProps<typeof DisplaySegmentRenderer>) {
  return (
    <div className="responses-display-segment" data-protocol="responses">
      <DisplaySegmentRenderer {...props} />
    </div>
  );
}
