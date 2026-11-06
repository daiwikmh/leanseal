"use client"

import HalftoneWordmarkFooter from "@/components/ui/halftone-wordmark-footer"

export default function Demo() {
  return <div className="w-full"><HalftoneWordmarkFooter
    wordmark="leanseal"
    label="LeanSeal · Private Ethereum transactions"
    meta="©2026 · Research prototype"
    preset="paper"
    palette={{background:"#e4e3dc",ink:"#26251e",warm:"#f76d18"}}
    height="clamp(460px, 42vw, 640px)"
    columns={[
      {title:"Explore",links:[{label:"How it works",href:"#how-it-works"},{label:"The console",href:"#console"}]},
      {title:"Build",links:[{label:"Open console ↗",href:"/dashboard"},{label:"How it works",href:"#how-it-works"}]},
      {title:"About",links:[{label:"Trust & limitations",href:"#trust"},{label:"Back to the top",href:"#main"}]},
    ]}
  /></div>
}
