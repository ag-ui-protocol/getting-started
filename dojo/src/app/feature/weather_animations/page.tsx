"use client";
import React, { useState, useEffect } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import {
  CopilotKit,
  useCopilotAction,
} from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";

type WeatherType = 'clear' | 'rain' | 'snow' | 'wind' | 'clouds' | 'storm' | 'sunset' | 'night';

interface WeatherState {
  type: WeatherType;
  intensity: 'light' | 'medium' | 'heavy';
  duration?: number;
}

const WeatherAnimations: React.FC = () => {
  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      showDevConsole={false}
      agent="weatherAnimationsAgent"
    >
      <WeatherScene />
    </CopilotKit>
  );
};

const WeatherScene = () => {
  const [weatherState, setWeatherState] = useState<WeatherState>({
    type: 'clear',
    intensity: 'medium'
  });
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Agent action to change weather
  useCopilotAction({
    name: "change_weather",
    description: "Change the weather animation based on the conversation context. Use this when users mention weather, emotions, or atmospheric conditions.",
    parameters: [
      {
        name: "weatherType",
        type: "string",
        description: "Type of weather: clear, rain, snow, wind, clouds, storm, sunset, night",
      },
      {
        name: "intensity",
        type: "string", 
        description: "Intensity level: light, medium, heavy",
      },
      {
        name: "reason",
        type: "string",
        description: "Why this weather was chosen based on the conversation",
      }
    ],
    handler: ({ weatherType, intensity, reason }) => {
      console.log(`Changing weather to ${weatherType} (${intensity}) - ${reason}`);
      
      setIsTransitioning(true);
      setTimeout(() => {
        setWeatherState({
          type: weatherType as WeatherType,
          intensity: (intensity as 'light' | 'medium' | 'heavy') || 'medium'
        });
        setIsTransitioning(false);
      }, 500);
      
      return `Weather changed to ${weatherType} with ${intensity} intensity. ${reason}`;
    },
    followUp: false,
  });

  // Auto-detect weather keywords in conversation
  useCopilotAction({
    name: "detect_mood_weather",
    description: "Automatically detect mood or weather-related context and change the atmosphere accordingly",
    parameters: [
      {
        name: "mood",
        type: "string",
        description: "Detected mood: happy, sad, excited, calm, energetic, peaceful, dramatic, mysterious",
      }
    ],
    handler: ({ mood }) => {
      const moodWeatherMap: Record<string, { type: WeatherType; intensity: 'light' | 'medium' | 'heavy' }> = {
        happy: { type: 'clear', intensity: 'light' },
        excited: { type: 'wind', intensity: 'medium' },
        calm: { type: 'clouds', intensity: 'light' },
        peaceful: { type: 'sunset', intensity: 'light' },
        sad: { type: 'rain', intensity: 'medium' },
        dramatic: { type: 'storm', intensity: 'heavy' },
        mysterious: { type: 'night', intensity: 'medium' },
        energetic: { type: 'wind', intensity: 'heavy' }
      };

      const weather = moodWeatherMap[mood] || { type: 'clear', intensity: 'medium' };
      
      setIsTransitioning(true);
      setTimeout(() => {
        setWeatherState(weather);
        setIsTransitioning(false);
      }, 500);

      return `Atmosphere changed to match ${mood} mood`;
    },
    followUp: false,
  });

  const getWeatherDescription = () => {
    const descriptions = {
      clear: "☀️ Clear skies with gentle warmth",
      rain: "🌧️ Gentle raindrops creating ripples",
      snow: "❄️ Soft snowflakes dancing in the air", 
      wind: "💨 Swirling winds with moving elements",
      clouds: "☁️ Peaceful cloudy atmosphere",
      storm: "⛈️ Dramatic stormy weather with lightning",
      sunset: "🌅 Beautiful sunset colors painting the sky",
      night: "🌙 Mysterious nighttime with twinkling stars"
    };
    return descriptions[weatherState.type];
  };

  return (
    <div className={`weather-container ${weatherState.type} ${weatherState.intensity} ${isTransitioning ? 'transitioning' : ''}`}>
      {/* Weather Effects Layer */}
      <div className="weather-effects">
        {weatherState.type === 'rain' && <RainEffect intensity={weatherState.intensity} />}
        {weatherState.type === 'snow' && <SnowEffect intensity={weatherState.intensity} />}
        {weatherState.type === 'wind' && <WindEffect intensity={weatherState.intensity} />}
        {weatherState.type === 'clouds' && <CloudEffect intensity={weatherState.intensity} />}
        {weatherState.type === 'storm' && <StormEffect intensity={weatherState.intensity} />}
        {weatherState.type === 'sunset' && <SunsetEffect />}
        {weatherState.type === 'night' && <NightEffect />}
      </div>

      {/* Content Layer */}
      <div className="content-layer">
        <div className="flex h-full w-full">
          {/* Main Content Area */}
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="weather-display text-center backdrop-blur-sm bg-white/10 rounded-2xl p-8 border border-white/20">
              <h1 className="text-5xl font-bold mb-4 text-white drop-shadow-lg">
                Weather Animations
              </h1>
              <div className="text-2xl mb-6 text-white/90">
                {getWeatherDescription()}
              </div>
              <div className="text-lg text-white/80 mb-4">
                Current: <span className="font-semibold capitalize">{weatherState.type}</span> 
                {' '}({weatherState.intensity})
              </div>
              <div className="text-sm text-white/70 max-w-md">
                💬 Chat with the agent about weather, moods, or emotions to see the animations change dynamically!
              </div>
            </div>
          </div>
          
          {/* Chat Sidebar */}
          <div className="w-96 backdrop-blur-md bg-white/5 border-l border-white/20">
            <CopilotChat
              className="h-full weather-chat"
              labels={{ 
                initial: "Hi! I can change the weather and atmosphere based on our conversation. Try mentioning weather, emotions, or moods!" 
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// Weather Effect Components
const RainEffect = ({ intensity }: { intensity: string }) => (
  <div className={`rain-effect ${intensity}`}>
    {Array.from({ length: intensity === 'heavy' ? 200 : intensity === 'medium' ? 100 : 50 }, (_, i) => (
      <div key={i} className="raindrop" style={{
        left: `${Math.random() * 100}%`,
        animationDelay: `${Math.random() * 2}s`,
        animationDuration: `${0.5 + Math.random() * 0.5}s`
      }} />
    ))}
  </div>
);

const SnowEffect = ({ intensity }: { intensity: string }) => (
  <div className={`snow-effect ${intensity}`}>
    {Array.from({ length: intensity === 'heavy' ? 150 : intensity === 'medium' ? 75 : 40 }, (_, i) => (
      <div key={i} className="snowflake" style={{
        left: `${Math.random() * 100}%`,
        animationDelay: `${Math.random() * 3}s`,
        animationDuration: `${2 + Math.random() * 3}s`,
        fontSize: `${8 + Math.random() * 8}px`
      }}>❄</div>
    ))}
  </div>
);

const WindEffect = ({ intensity }: { intensity: string }) => (
  <div className={`wind-effect ${intensity}`}>
    {Array.from({ length: 30 }, (_, i) => (
      <div key={i} className="wind-particle" style={{
        top: `${Math.random() * 100}%`,
        animationDelay: `${Math.random() * 2}s`,
        animationDuration: `${1 + Math.random() * 2}s`
      }} />
    ))}
  </div>
);

const CloudEffect = ({ intensity }: { intensity: string }) => (
  <div className={`cloud-effect ${intensity}`}>
    <div className="cloud cloud-1">☁️</div>
    <div className="cloud cloud-2">☁️</div>
    <div className="cloud cloud-3">☁️</div>
  </div>
);

const StormEffect = ({ intensity }: { intensity: string }) => (
  <div className={`storm-effect ${intensity}`}>
    <div className="lightning-flash" />
    <RainEffect intensity="heavy" />
    {Array.from({ length: 5 }, (_, i) => (
      <div key={i} className="lightning-bolt" style={{
        left: `${20 + Math.random() * 60}%`,
        animationDelay: `${Math.random() * 3}s`
      }}>⚡</div>
    ))}
  </div>
);

const SunsetEffect = () => (
  <div className="sunset-effect">
    <div className="sun">☀️</div>
    <div className="sunset-glow" />
  </div>
);

const NightEffect = () => (
  <div className="night-effect">
    <div className="moon">🌙</div>
    {Array.from({ length: 50 }, (_, i) => (
      <div key={i} className="star" style={{
        top: `${Math.random() * 70}%`,
        left: `${Math.random() * 100}%`,
        animationDelay: `${Math.random() * 3}s`
      }}>✨</div>
    ))}
  </div>
);

export default WeatherAnimations;
