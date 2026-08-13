/**
 * A travel agent supervisor demo showcasing multi-agent architecture with subgraphs.
 * The supervisor coordinates specialized agents: flights finder, hotels finder, and experiences finder.
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  MessagesAnnotation,
  StateGraph,
  Command,
  START,
  END,
  interrupt
} from "@langchain/langgraph";
import { aguiTransformer } from "@ag-ui/langgraph/transformer";

// Travel data interfaces
interface Flight {
  airline: string;
  departure: string;
  arrival: string;
  price: string;
  duration: string;
}

interface Hotel {
  name: string;
  location: string;
  price_per_night: string;
  rating: string;
}

interface Experience {
  name: string;
  type: "restaurant" | "activity";
  description: string;
  location: string;
}

interface Itinerary {
  flight?: Flight;
  hotel?: Hotel;
}

// Custom reducer to merge itinerary updates
function mergeItinerary(left: Itinerary | null, right?: Itinerary | null): Itinerary {
  if (!left) left = {};
  if (!right) right = {};
  return { ...left, ...right };
}

// State annotation for travel agent system
export const TravelAgentStateAnnotation = Annotation.Root({
  origin: Annotation<string>(),
  destination: Annotation<string>(),
  flights: Annotation<Flight[] | null>(),
  hotels: Annotation<Hotel[] | null>(),
  experiences: Annotation<Experience[] | null>(),

  // Itinerary with custom merger
  itinerary: Annotation<Itinerary | null>({
    reducer: mergeItinerary,
    default: () => null
  }),

  // Tools available to all agents
  tools: Annotation<any[]>({
    reducer: (x, y) => y ?? x,
    default: () => []
  }),

  // Supervisor routing
  next_agent: Annotation<string | null>(),
  ...MessagesAnnotation.spec,
});

export type TravelAgentState = typeof TravelAgentStateAnnotation.State;

// Static data for demonstration
const STATIC_FLIGHTS: Flight[] = [
  { airline: "KLM", departure: "Amsterdam (AMS)", arrival: "San Francisco (SFO)", price: "$650", duration: "11h 30m" },
  { airline: "United", departure: "Amsterdam (AMS)", arrival: "San Francisco (SFO)", price: "$720", duration: "12h 15m" }
];

const STATIC_HOTELS: Hotel[] = [
  { name: "Hotel Zephyr", location: "Fisherman's Wharf", price_per_night: "$280/night", rating: "4.2 stars" },
  { name: "The Ritz-Carlton", location: "Nob Hill", price_per_night: "$550/night", rating: "4.8 stars" },
  { name: "Hotel Zoe", location: "Union Square", price_per_night: "$320/night", rating: "4.4 stars" }
];

const STATIC_EXPERIENCES: Experience[] = [
  { name: "Pier 39", type: "activity", description: "Iconic waterfront destination with shops and sea lions", location: "Fisherman's Wharf" },
  { name: "Golden Gate Bridge", type: "activity", description: "World-famous suspension bridge with stunning views", location: "Golden Gate" },
  { name: "Swan Oyster Depot", type: "restaurant", description: "Historic seafood counter serving fresh oysters", location: "Polk Street" },
  { name: "Tartine Bakery", type: "restaurant", description: "Artisanal bakery famous for bread and pastries", location: "Mission District" }
];

function createInterrupt(message: string, options: any[], recommendation: any, agent: string) {
  return interrupt({
    message,
    options,
    recommendation,
    agent,
  });
}

// Flights finder subgraph
async function flightsFinder(state: TravelAgentState, config?: RunnableConfig): Promise<Command> {
  // Simulate flight search with static data
  const flights = STATIC_FLIGHTS;

  const selectedFlight = state.itinerary?.flight;
  
  let flightChoice: Flight;
  const message = `Found ${flights.length} flight options from ${state.origin || 'Amsterdam'} to ${state.destination || 'San Francisco'}.\n` +
    `I recommend choosing the flight by ${flights[0].airline} since it's known to be on time and cheaper.`
  if (!selectedFlight) {
    const interruptResult = createInterrupt(
      message,
      flights,
      flights[0],
      "flights"
    );
    
    // Parse the interrupt result if it's a string
    flightChoice = typeof interruptResult === 'string' ? JSON.parse(interruptResult) : interruptResult;
  } else {
    flightChoice = selectedFlight;
  }

  return new Command({
    goto: END,
    update: {
      flights: flights,
      itinerary: {
        flight: flightChoice
      },
      // Return all "messages" that the agent was sending
      messages: [
        ...state.messages,
        new AIMessage({
          content: message,
        }),
        new AIMessage({
          content: `Flights Agent: Great. I'll book you the ${flightChoice.airline} flight from ${flightChoice.departure} to ${flightChoice.arrival}.`,
        }),
      ]
    }
  });
}

// Hotels finder subgraph
async function hotelsFinder(state: TravelAgentState, config?: RunnableConfig): Promise<Command> {
  // Simulate hotel search with static data
  const hotels = STATIC_HOTELS;
  const selectedHotel = state.itinerary?.hotel;
  
  let hotelChoice: Hotel;
  const message = `Found ${hotels.length} accommodation options in ${state.destination || 'San Francisco'}.\n
    I recommend choosing the ${hotels[2].name} since it strikes the balance between rating, price, and location.`
  if (!selectedHotel) {
    const interruptResult = createInterrupt(
      message,
      hotels,
      hotels[2],
      "hotels"
    );
    
    // Parse the interrupt result if it's a string
    hotelChoice = typeof interruptResult === 'string' ? JSON.parse(interruptResult) : interruptResult;
  } else {
    hotelChoice = selectedHotel;
  }

  return new Command({
    goto: END,
    update: {
      hotels: hotels,
      itinerary: {
        hotel: hotelChoice
      },
      // Return all "messages" that the agent was sending
      messages: [
        ...state.messages,
        new AIMessage({
          content: message,
        }),
        new AIMessage({
          content: `Hotels Agent: Excellent choice! You'll like ${hotelChoice.name}.`
        }),
      ]
    }
  });
}

// Experiences finder subgraph
async function experiencesFinder(state: TravelAgentState, config?: RunnableConfig): Promise<Command> {
  // Filter experiences (2 restaurants, 2 activities)
  const restaurants = STATIC_EXPERIENCES.filter(exp => exp.type === "restaurant").slice(0, 2);
  const activities = STATIC_EXPERIENCES.filter(exp => exp.type === "activity").slice(0, 2);
  const experiences = [...restaurants, ...activities];

  const model = new ChatOpenAI({ model: "gpt-4o" });

  if (!config) {
    config = { recursionLimit: 25 };
  }

  const itinerary = state.itinerary || {};

  const systemPrompt = `
    You are the experiences agent. Your job is to find restaurants and activities for the user.
    You already went ahead and found a bunch of experiences. All you have to do now, is to let the user know of your findings.
    
    Current status:
    - Origin: ${state.origin || 'Amsterdam'}
    - Destination: ${state.destination || 'San Francisco'}
    - Flight chosen: ${JSON.stringify(itinerary.flight) || 'None'}
    - Hotel chosen: ${JSON.stringify(itinerary.hotel) || 'None'}
    - Activities found: ${JSON.stringify(activities)}
    - Restaurants found: ${JSON.stringify(restaurants)}
    `;

  // Get experiences response
  const response = await model.invoke([
    new SystemMessage({ content: systemPrompt }),
    ...state.messages,
  ], config);

  return new Command({
    goto: END,
    update: {
      experiences: experiences,
      messages: [...state.messages, response]
    }
  });
}

// Supervisor response tool
const SUPERVISOR_RESPONSE_TOOL = {
  type: "function" as const,
  function: {
    name: "supervisor_response",
    description: "Always use this tool to structure your response to the user.",
    parameters: {
      type: "object",
      properties: {
        answer: {
          type: "string",
          description: "The answer to the user"
        },
        next_agent: {
          type: "string",
          enum: ["flights_agent", "hotels_agent", "experiences_agent", "complete"],
          description: "The agent to go to. Not required if you do not want to route to another agent."
        }
      },
      required: ["answer"]
    }
  }
};

// Supervisor agent
async function supervisorAgent(state: TravelAgentState, config?: RunnableConfig): Promise<Command> {
  const itinerary = state.itinerary || {};

  // Check what's already completed
  const hasFlights = itinerary.flight !== undefined;
  const hasHotels = itinerary.hotel !== undefined;
  const hasExperiences = state.experiences !== null;

  const systemPrompt = `
    You are a travel planning supervisor. Your job is to coordinate specialized agents to help plan a trip.
    
    Current status:
    - Origin: ${state.origin || 'Amsterdam'}
    - Destination: ${state.destination || 'San Francisco'}
    - Flights found: ${hasFlights}
    - Hotels found: ${hasHotels}
    - Experiences found: ${hasExperiences}
    - Itinerary (Things that the user has already confirmed selection on): ${JSON.stringify(itinerary, null, 2)}
    
    Available agents:
    - flights_agent: Finds flight options
    - hotels_agent: Finds hotel options  
    - experiences_agent: Finds restaurant and activity recommendations
    - complete: Mark task as complete when all information is gathered
    
    You must route to the appropriate agent based on what's missing. Once all agents have completed their tasks, route to 'complete'.
    `;

  // Define the model
  const model = new ChatOpenAI({ model: "gpt-4o" });

  if (!config) {
    config = { recursionLimit: 25 };
  }

  // Bind the routing tool
  const modelWithTools = model.bindTools(
    [SUPERVISOR_RESPONSE_TOOL],
    {
      parallel_tool_calls: false,
    }
  );

  // Get supervisor decision
  const response = await modelWithTools.invoke([
    new SystemMessage({ content: systemPrompt }),
    ...state.messages,
  ], config);

  let messages = [...state.messages, response];

  // Handle tool calls for routing
  if (response.tool_calls && response.tool_calls.length > 0) {
    const toolCall = response.tool_calls[0];
    const toolCallArgs = toolCall.args;
    const nextAgent = toolCallArgs.next_agent;

    const toolResponse = new ToolMessage({
      tool_call_id: toolCall.id!,
      content: `Routing to ${nextAgent} and providing the answer`,
    });

    messages = [
      ...messages, 
      toolResponse, 
      new AIMessage({ content: toolCallArgs.answer })
    ];

    if (nextAgent && nextAgent !== "complete") {
      return new Command({ goto: nextAgent });
    }
  }

  // Fallback if no tool call or complete
  return new Command({
    goto: END,
    update: { messages }
  });
}

// Create subgraphs
const flightsGraph = new StateGraph(TravelAgentStateAnnotation);
flightsGraph.addNode("flights_agent_chat_node", flightsFinder);
flightsGraph.setEntryPoint("flights_agent_chat_node");
flightsGraph.addEdge(START, "flights_agent_chat_node");
flightsGraph.addEdge("flights_agent_chat_node", END);
const flightsSubgraph = flightsGraph.compile();

const hotelsGraph = new StateGraph(TravelAgentStateAnnotation);
hotelsGraph.addNode("hotels_agent_chat_node", hotelsFinder);
hotelsGraph.setEntryPoint("hotels_agent_chat_node");
hotelsGraph.addEdge(START, "hotels_agent_chat_node");
hotelsGraph.addEdge("hotels_agent_chat_node", END);
const hotelsSubgraph = hotelsGraph.compile();

const experiencesGraph = new StateGraph(TravelAgentStateAnnotation);
experiencesGraph.addNode("experiences_agent_chat_node", experiencesFinder);
experiencesGraph.setEntryPoint("experiences_agent_chat_node");
experiencesGraph.addEdge(START, "experiences_agent_chat_node");
experiencesGraph.addEdge("experiences_agent_chat_node", END);
const experiencesSubgraph = experiencesGraph.compile();

// Main supervisor workflow
const workflow = new StateGraph(TravelAgentStateAnnotation);

// Add supervisor and subgraphs as nodes
workflow.addNode("supervisor", supervisorAgent, { ends: ['flights_agent', 'hotels_agent', 'experiences_agent', END] });
workflow.addNode("flights_agent", flightsSubgraph);
workflow.addNode("hotels_agent", hotelsSubgraph);
workflow.addNode("experiences_agent", experiencesSubgraph);

// Set entry point
workflow.setEntryPoint("supervisor");
workflow.addEdge(START, "supervisor");

// Add edges back to supervisor after each subgraph
workflow.addEdge("flights_agent", "supervisor");
workflow.addEdge("hotels_agent", "supervisor");
workflow.addEdge("experiences_agent", "supervisor");

// Compile the graph
export const subGraphsAgentGraph = workflow.compile({
  transformers: [aguiTransformer],
});
