"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Plus, MessageSquare, Users, Settings } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import A2AChat from "./a2a_chat";

interface PageProps {
  params: Promise<{
    integrationId: string;
  }>;
}

function Page({ params }: PageProps) {
  const [activeTab, setActiveTab] = useState("chat-1");
  const [tabs, setTabs] = useState([{ id: "chat-1", label: "Main Chat", icon: MessageSquare }]);
  const [chatInstances, setChatInstances] = useState<Record<string, React.ReactElement>>({});
  const [tabNotifications, setTabNotifications] = useState<Record<string, boolean>>({});

  const activeTabRef = useRef(activeTab);

  // Function to add notification badge to a specific tab
  const addNotification = useCallback(
    (tabId: string) => {
      // Only add notification if the tab is not currently active
      console.log("addNotification", tabId, activeTabRef.current);
      if (tabId !== activeTabRef.current) {
        setTabNotifications((prev) => ({
          ...prev,
          [tabId]: true,
        }));
      }
    },
    [activeTabRef.current],
  );

  // Clear notification when tab becomes active
  const handleTabChange = useCallback((tabId: string) => {
    activeTabRef.current = tabId;
    setActiveTab(tabId);
    // Clear notification for the newly active tab
    setTabNotifications((prev) => ({
      ...prev,
      [tabId]: false,
    }));
  }, []);

  // Initialize chat instances when tabs change
  useEffect(() => {
    const newInstances = { ...chatInstances };

    tabs.forEach((tab) => {
      if (!newInstances[tab.id]) {
        newInstances[tab.id] = (
          <A2AChat key={tab.id} params={params} onNotification={() => addNotification(tab.id)} />
        );
      }
    });

    // DEFERRED (PNI-272): `react-hooks/set-state-in-effect`. Caching the chat
    // elements here is load-bearing, not incidental: it pins each chat's
    // `onNotification` closure for the lifetime of the tab. Rendering <A2AChat>
    // directly instead creates a fresh closure every parent render, which
    // re-fires the notification effect in a2a_chat.tsx (it lists
    // `onNotification` in its deps); that calls `setTabNotifications`, which
    // always allocates a new object, re-renders this component and loops
    // forever for any inactive tab holding messages. Left as-is until the
    // notification wiring is reshaped to pass a stable callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChatInstances(newInstances);
  }, [tabs, params, addNotification]);

  const handleAddTab = () => {
    const newTab = {
      id: `chat-${Date.now()}`,
      label: `Chat ${tabs.length + 1}`,
      icon: MessageSquare,
    };
    setTabs([...tabs, newTab]);
    activeTabRef.current = newTab.id;
    setActiveTab(newTab.id);
  };

  return (
    <div className="h-full w-full bg-gradient-to-br from-slate-50 to-slate-100">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="h-full flex flex-col">
        {/* Beautiful Tab Bar */}
        <div className="bg-white/80 backdrop-blur-sm border-b border-slate-200/60 px-6 py-3 h-[65px]">
          <div className="flex items-center justify-between">
            <TabsList className="bg-slate-100/70 p-1 rounded-xl shadow-sm">
              {tabs.map((tab) => {
                const IconComponent = tab.icon;
                const hasNotification = tabNotifications[tab.id];
                return (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg transition-all duration-200 data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-slate-900 text-slate-600 hover:text-slate-900 relative"
                  >
                    <IconComponent className="h-4 w-4" />
                    <span className="font-medium">{tab.label}</span>
                    {/* Notification Badge */}
                    {hasNotification && (
                      <div className="absolute top-0.5 left-2 w-3 h-3 bg-blue-500 rounded-full border-2 border-white shadow-sm animate-pulse" />
                    )}
                  </TabsTrigger>
                );
              })}

              {/* Plus Button Tab */}
              <button
                onClick={handleAddTab}
                className="flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-200 text-slate-500 hover:text-slate-700 hover:bg-slate-200/50 group"
                title="Add new chat"
              >
                <Plus className="h-4 w-4 group-hover:rotate-90 transition-transform duration-200" />
                <span className="font-medium text-sm">New</span>
              </button>
            </TabsList>

            {/* Settings Button */}
            <button className="p-2 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-200/50 transition-all duration-200">
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Tab Contents - All chat instances stay mounted */}
        <div className="flex-1 overflow-hidden relative">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`absolute inset-0 h-full transition-opacity duration-200 ${
                activeTab === tab.id
                  ? "opacity-100 pointer-events-auto"
                  : "opacity-0 pointer-events-none"
              }`}
            >
              <div className="h-full relative">
                {/* Chat Background Decoration */}
                <div className="absolute inset-0 bg-gradient-to-br from-blue-50/30 via-purple-50/20 to-pink-50/30 pointer-events-none" />
                <div className="absolute top-0 left-0 w-96 h-96 bg-gradient-to-br from-blue-400/10 to-purple-400/10 rounded-full blur-3xl pointer-events-none" />
                <div className="absolute bottom-0 right-0 w-96 h-96 bg-gradient-to-br from-pink-400/10 to-orange-400/10 rounded-full blur-3xl pointer-events-none" />

                {/* Chat Content */}
                <div className="relative h-full p-6">
                  <div className="h-full bg-white/50 backdrop-blur-sm rounded-2xl shadow-xl border border-white/20">
                    {chatInstances[tab.id]}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Tabs>
    </div>
  );
}

export default Page;
