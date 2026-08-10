"use client";
import React, { useState, useEffect } from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  useAgent,
  UseAgentUpdate,
  useConfigureSuggestions,
  CopilotSidebar,
  CopilotChatConfigurationProvider,
} from "@copilotkit/react-core/v2";
import { CopilotKit,
useLangGraphInterrupt } from "@copilotkit/react-core";
import { useMobileView } from "@/utils/use-mobile-view";
import { useMobileChat } from "@/utils/use-mobile-chat";
import { useURLParams } from "@/contexts/url-params-context";

interface SubgraphsProps {
  params: Promise<{
    integrationId: string;
  }>;
}

// Travel planning data types
interface Flight {
  airline: string;
  arrival: string;
  departure: string;
  duration: string;
  price: string;
}

interface Hotel {
  location: string;
  name: string;
  price_per_night: string;
  rating: string;
}

interface Experience {
  name: string;
  description: string;
  location: string;
  type: string;
}

interface Itinerary {
  hotel?: Hotel;
  flight?: Flight;
  experiences?: Experience[];
}

type AvailableAgents = 'flights' | 'hotels' | 'experiences' | 'supervisor'

interface TravelAgentState {
  experiences: Experience[],
  flights: Flight[],
  hotels: Hotel[],
  itinerary: Itinerary
  planning_step: string
  active_agent: AvailableAgents
}

const INITIAL_STATE: TravelAgentState = {
  itinerary: {},
  experiences: [],
  flights: [],
  hotels: [],
  planning_step: "start",
  active_agent: 'supervisor'
};

interface InterruptEvent<TAgent extends AvailableAgents> {
  message: string;
  options: TAgent extends 'flights' ? Flight[] : TAgent extends 'hotels' ? Hotel[] : never,
  recommendation: TAgent extends 'flights' ? Flight : TAgent extends 'hotels' ? Hotel : never,
  agent: TAgent
}

function InterruptHumanInTheLoop<TAgent extends AvailableAgents>({
  event,
  resolve,
}: {
  event: { value: InterruptEvent<TAgent> };
  resolve: (value: string) => void;
}) {
  const { message, options, agent, recommendation } = event.value;

  // Format agent name with emoji
  const formatAgentName = (agent: string) => {
    switch (agent) {
      case 'flights': return 'Flights Agent';
      case 'hotels': return 'Hotels Agent';
      case 'experiences': return 'Experiences Agent';
      default: return `${agent} Agent`;
    }
  };

  const handleOptionSelect = (option: unknown) => {
    resolve(JSON.stringify(option));
  };

  return (
    <div className="interrupt-container">
      <p>{formatAgentName(agent)}: {message}</p>

      <div className="interrupt-options">
        {options.map((opt, idx) => {
          if ('airline' in opt) {
            const isRecommended = (recommendation as Flight).airline === opt.airline;
            // Flight options
            return (
              <button
                key={idx}
                className={`option-card flight-option ${isRecommended ? 'recommended' : ''}`}
                onClick={() => handleOptionSelect(opt)}
              >
                {isRecommended && <span className="recommendation-badge">⭐ Recommended</span>}
                <div className="option-header">
                  <span className="airline-name">{opt.airline}</span>
                  <span className="price">{opt.price}</span>
                </div>
                <div className="route-info">
                  {opt.departure} → {opt.arrival}
                </div>
                <div className="duration-info">
                  {opt.duration}
                </div>
              </button>
            );
          }
          const isRecommended = (recommendation as Hotel).name === opt.name;

          // Hotel options
          return (
            <button
              key={idx}
              className={`option-card hotel-option ${isRecommended ? 'recommended' : ''}`}
              onClick={() => handleOptionSelect(opt)}
            >
              {isRecommended && <span className="recommendation-badge">⭐ Recommended</span>}
              <div className="option-header">
                <span className="hotel-name">{opt.name}</span>
                <span className="rating">{opt.rating}</span>
              </div>
              <div className="location-info">
                📍 {opt.location}
              </div>
              <div className="price-info">
                {opt.price_per_night}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  )
}

export default function Subgraphs({ params }: SubgraphsProps) {
  const { integrationId } = React.use(params);
  const { isMobile } = useMobileView();
  const { chatDefaultOpen } = useURLParams();
  const defaultChatHeight = 50;
  const {
    isChatOpen,
    setChatHeight,
    setIsChatOpen,
    isDragging,
    chatHeight,
    handleDragStart
  } = useMobileChat(defaultChatHeight);

  const chatTitle = 'Travel Planning Assistant';
  const chatDescription = 'Plan your perfect trip with AI specialists';

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="subgraphs"
    >
      <CopilotChatConfigurationProvider agentId="subgraphs">
      <div className="travel-planner-container">
        <TravelPlanner />
        {isMobile ? (
          <>
            {/* Chat Toggle Button */}
            <div className="fixed bottom-0 left-0 right-0 z-50">
              <div className="bg-gradient-to-t from-white via-white to-transparent h-6"></div>
              <div
                className="bg-white border-t border-gray-200 px-4 py-3 flex items-center justify-between cursor-pointer shadow-lg"
                onClick={() => {
                  if (!isChatOpen) {
                    setChatHeight(defaultChatHeight);
                  }
                  setIsChatOpen(!isChatOpen);
                }}
              >
                <div className="flex items-center gap-3">
                  <div>
                    <div className="font-medium text-gray-900">{chatTitle}</div>
                    <div className="text-sm text-gray-500">{chatDescription}</div>
                  </div>
                </div>
                <div className={`transform transition-transform duration-300 ${isChatOpen ? 'rotate-180' : ''}`}>
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Pull-Up Chat Container */}
            <div
              className={`fixed inset-x-0 bottom-0 z-40 bg-white rounded-t-2xl shadow-[0px_0px_20px_0px_rgba(0,0,0,0.15)] transform transition-all duration-300 ease-in-out flex flex-col ${
                isChatOpen ? 'translate-y-0' : 'translate-y-full'
              } ${isDragging ? 'transition-none' : ''}`}
              style={{
                height: `${chatHeight}vh`,
                paddingBottom: 'env(safe-area-inset-bottom)'
              }}
            >
              {/* Drag Handle Bar */}
              <div
                className="flex justify-center pt-3 pb-2 flex-shrink-0 cursor-grab active:cursor-grabbing"
                onMouseDown={handleDragStart}
              >
                <div className="w-12 h-1 bg-gray-400 rounded-full hover:bg-gray-500 transition-colors"></div>
              </div>

              {/* Chat Header */}
              <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-gray-900">{chatTitle}</h3>
                  </div>
                  <button
                    onClick={() => setIsChatOpen(false)}
                    className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                  >
                    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Chat Content */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden pb-16">
                <CopilotSidebar
                  agentId="subgraphs"
                  defaultOpen={chatDefaultOpen}
                  labels={{
                    modalHeaderTitle: chatTitle,
                  }}
                />
              </div>
            </div>

            {/* Backdrop */}
            {isChatOpen && (
              <div
                className="fixed inset-0 z-30"
                onClick={() => setIsChatOpen(false)}
              />
            )}
          </>
        ) : (
          <CopilotSidebar
            agentId="subgraphs"
            defaultOpen={chatDefaultOpen}
            labels={{
              modalHeaderTitle: chatTitle,
            }}
          />
        )}
      </div>
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
}

function TravelPlanner() {
  const { isMobile } = useMobileView();
  const { agent } = useAgent({
    agentId: "subgraphs",
    updates: [UseAgentUpdate.OnStateChanged],
  });

  const agentState = agent.state as TravelAgentState | undefined;

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Plan a trip",
        message: "Plan a trip to Paris for 5 days.",
      },
      {
        title: "Find flights",
        message: "Find me flights to Tokyo.",
      },
      {
        title: "Explore experiences",
        message: "What are the best experiences in Barcelona?",
      },
    ],
    available: "always",
  });

  // Set initial state on mount
  useEffect(() => {
    if (!agentState) {
      agent.setState(INITIAL_STATE);
    }
  }, []);

  useLangGraphInterrupt({
    render: ({ event, resolve }) => <InterruptHumanInTheLoop event={event} resolve={resolve} />,
  });

  // Current itinerary strip
  const ItineraryStrip = () => {
    const selectedFlight = agentState?.itinerary?.flight;
    const selectedHotel = agentState?.itinerary?.hotel;
    const hasExperiences = (agentState?.experiences?.length ?? 0) > 0;

    return (
      <div className="itinerary-strip">
        <div className="itinerary-label">Current Itinerary:</div>
        <div className="itinerary-items">
          <div className="itinerary-item">
            <span className="item-icon">📍</span>
            <span>Amsterdam → San Francisco</span>
          </div>
          {selectedFlight && (
            <div className="itinerary-item" data-testid="selected-flight">
              <span className="item-icon">✈️</span>
              <span>{selectedFlight.airline} - {selectedFlight.price}</span>
            </div>
          )}
          {selectedHotel && (
            <div className="itinerary-item" data-testid="selected-hotel">
              <span className="item-icon">🏨</span>
              <span>{selectedHotel.name}</span>
            </div>
          )}
          {hasExperiences && (
            <div className="itinerary-item">
              <span className="item-icon">🎯</span>
              <span>{agentState?.experiences?.length ?? 0} experiences planned</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Compact agent status - read active_agent from state instead of nodeName
  const AgentStatus = () => {
    const activeAgent = agentState?.active_agent || 'supervisor';

    return (
      <div className="agent-status">
        <div className="status-label">Active Agent:</div>
        <div className="agent-indicators">
          <div className={`agent-indicator ${activeAgent === 'supervisor' ? 'active' : ''}`} data-testid="supervisor-indicator">
            <span>👨‍💼</span>
            <span>Supervisor</span>
          </div>
          <div className={`agent-indicator ${activeAgent === 'flights' ? 'active' : ''}`} data-testid="flights-agent-indicator">
            <span>✈️</span>
            <span>Flights</span>
          </div>
          <div className={`agent-indicator ${activeAgent === 'hotels' ? 'active' : ''}`} data-testid="hotels-agent-indicator">
            <span>🏨</span>
            <span>Hotels</span>
          </div>
          <div className={`agent-indicator ${activeAgent === 'experiences' ? 'active' : ''}`} data-testid="experiences-agent-indicator">
            <span>🎯</span>
            <span>Experiences</span>
          </div>
        </div>
      </div>
    )
  };

  // Travel details component
  const TravelDetails = () => (
    <div className="travel-details">
      <div className="details-section">
        <h4>✈️ Flight Options</h4>
        <div className="detail-items">
          {(agentState?.flights?.length ?? 0) > 0 ? (
            agentState!.flights.map((flight, index) => (
              <div key={index} className="detail-item">
                <strong>{flight.airline}:</strong>
                <span>{flight.departure} → {flight.arrival} ({flight.duration}) - {flight.price}</span>
              </div>
            ))
          ) : (
            <p className="no-activities">No flights found yet</p>
          )}
          {agentState?.itinerary?.flight && (
            <div className="detail-tips">
              <strong>Selected:</strong> {agentState.itinerary.flight.airline} - {agentState.itinerary.flight.price}
            </div>
          )}
        </div>
      </div>

      <div className="details-section">
        <h4>🏨 Hotel Options</h4>
        <div className="detail-items">
          {(agentState?.hotels?.length ?? 0) > 0 ? (
            agentState!.hotels.map((hotel, index) => (
              <div key={index} className="detail-item">
                <strong>{hotel.name}:</strong>
                <span>{hotel.location} - {hotel.price_per_night} ({hotel.rating})</span>
              </div>
            ))
          ) : (
            <p className="no-activities">No hotels found yet</p>
          )}
          {agentState?.itinerary?.hotel && (
            <div className="detail-tips">
              <strong>Selected:</strong> {agentState.itinerary.hotel.name} - {agentState.itinerary.hotel.price_per_night}
            </div>
          )}
        </div>
      </div>

      <div className="details-section">
        <h4>🎯 Experiences</h4>
        <div className="detail-items">
          {(agentState?.experiences?.length ?? 0) > 0 ? (
            agentState!.experiences.map((experience, index) => (
              <div key={index} className="activity-item">
                <div className="activity-name">{experience.name}</div>
                <div className="activity-category">{experience.type}</div>
                <div className="activity-description">{experience.description}</div>
                <div className="activity-meta">Location: {experience.location}</div>
              </div>
            ))
          ) : (
            <p className="no-activities">No experiences planned yet</p>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="travel-content">
      {/* NOTE (PNI-272): these three stay defined inside TravelPlanner. Hoisting
          them to module scope gives React stable component identities, which
          stops the remount-per-render these currently do — a behaviour change. */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      <ItineraryStrip />
      {/* eslint-disable-next-line react-hooks/static-components */}
      <AgentStatus />
      {/* eslint-disable-next-line react-hooks/static-components */}
      <TravelDetails />
    </div>
  );
}
