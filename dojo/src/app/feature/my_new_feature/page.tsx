"use client";
import React, { useState } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import {
  CopilotKit,
  useCopilotAction,
} from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";

const MyNewFeature: React.FC = () => {
  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      showDevConsole={false}
      // agent lock to the relevant agent
      agent="myNewFeatureAgent"
    >
      <FeatureDemo />
    </CopilotKit>
  );
};

const FeatureDemo = () => {
  const [featureData, setFeatureData] = useState<string>("Initial State");

  useCopilotAction({
    name: "update_feature_data",
    description: "Update the feature data with new information",
    parameters: [
      {
        name: "newData",
        type: "string",
        description: "The new data to display",
      },
    ],
    handler: ({ newData }) => {
      console.log("Updating feature data to:", newData);
      setFeatureData(newData);
    },
    followUp: false,
  });

  return (
    <div className="flex h-full w-full">
      {/* Main Content Area */}
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="text-center p-8">
          <h1 className="text-4xl font-bold mb-4">My New Feature</h1>
          <div className="text-xl text-muted-foreground mb-8">
            Feature Data: {featureData}
          </div>
          <div className="text-sm text-muted-foreground">
            Try asking the agent to update the feature data!
          </div>
        </div>
      </div>
      
      {/* Chat Sidebar */}
      <div className="w-96 border-l">
        <CopilotChat
          className="h-full"
          labels={{ 
            initial: "Hi! I can help you interact with this feature. Try asking me to update the data!" 
          }}
        />
      </div>
    </div>
  );
};

export default MyNewFeature;
