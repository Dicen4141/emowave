"use client";

import { use } from "react";
import MindMapView from "@/components/MindMapView";

export default function MindMapPage({ params }: { params: Promise<{ assessmentId: string }> }) {
  const { assessmentId } = use(params);

  return (
    <div className="container">
      <h1>Mind Map</h1>
      <p className="subtitle">Generated from this client's already-processed report data — nothing here is fabricated beyond how it's organized.</p>
      <div className="card" style={{ overflowX: "auto" }}>
        <MindMapView assessmentId={assessmentId} />
      </div>
    </div>
  );
}
