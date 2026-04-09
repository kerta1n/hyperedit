import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

/**
 * Starter template for a custom HyperEdit transition.
 *
 * This component renders as a full-screen overlay during the transition window.
 * Frame 0 = transition start, last frame = transition end.
 * Use useCurrentFrame() and useVideoConfig() for all timing.
 *
 * Allowed imports: "remotion", "@remotion/shapes", "react"
 */
const CustomTransitionTemplate: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  // Expanding circle wipe from center
  const maxRadius = Math.sqrt(width ** 2 + height ** 2) / 2;
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateRight: "clamp",
  });
  const radius = progress * maxRadius;

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      <svg
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
      >
        <defs>
          <mask id="circle-wipe">
            <rect x={0} y={0} width={width} height={height} fill="white" />
            <circle cx={width / 2} cy={height / 2} r={radius} fill="black" />
          </mask>
        </defs>
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="black"
          mask="url(#circle-wipe)"
        />
      </svg>
    </AbsoluteFill>
  );
};

export default CustomTransitionTemplate;
