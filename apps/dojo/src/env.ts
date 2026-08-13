type envVars = {
  ag2Url: string;
  serverStarterUrl: string;
  serverStarterAllFeaturesUrl: string;
  mastraUrl: string;
  langgraphPythonUrl: string;
  langgraphFastApiUrl: string;
  langgraphTypescriptUrl: string;
  agnoUrl: string;
  springAiUrl: string;
  llamaIndexUrl: string;
  crewAiUrl: string;
  agentSpecUrl: string;
  pydanticAIUrl: string;
  adkMiddlewareUrl: string;
  adkMiddlewareJavaUrl: string;
  agentFrameworkPythonUrl: string;
  a2aUrl: string;
  agentFrameworkDotnetUrl: string;
  aguiDotnetUrl: string;
  a2aMiddlewareBuildingsManagementUrl: string;
  a2aMiddlewareFinanceUrl: string;
  a2aMiddlewareItUrl: string;
  a2aMiddlewareOrchestratorUrl: string;
  awsStrandsUrl: string;
  awsStrandsTypescriptUrl: string;
  claudeAgentSdkPythonUrl: string;
  claudeAgentSdkTypescriptUrl: string;
  claudeManagedAgentsDotnetUrl: string;
  claudeManagedAgentsPythonUrl: string;
  claudeManagedAgentsTypescriptUrl: string;
  langroidUrl: string;
  watsonxRegion: string;
  watsonxInstanceId: string;
  watsonxAgentId: string;
  watsonxApiKey: string;
  customDomainTitle: Record<string, string>;
};

export default function getEnvVars(): envVars {
  const customDomainTitle: Record<string, string> = {};
  if (process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_TITLE) {
    const [domain, title] =
      process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_TITLE.split("___");
    if (domain && title) {
      customDomainTitle[domain] = title;
    }
  }

  return {
    ag2Url: process.env.AG2_URL || "http://localhost:8018",
    serverStarterUrl: process.env.SERVER_STARTER_URL || "http://localhost:8000",
    serverStarterAllFeaturesUrl:
      process.env.SERVER_STARTER_ALL_FEATURES_URL || "http://localhost:8000",
    mastraUrl: process.env.MASTRA_URL || "http://localhost:4111",
    langgraphPythonUrl:
      process.env.LANGGRAPH_PYTHON_URL || "http://localhost:2024",
    langgraphFastApiUrl:
      process.env.LANGGRAPH_FAST_API_URL || "http://localhost:8000",
    langgraphTypescriptUrl:
      process.env.LANGGRAPH_TYPESCRIPT_URL || "http://localhost:2024",
    agnoUrl: process.env.AGNO_URL || "http://localhost:9001",
    llamaIndexUrl: process.env.LLAMA_INDEX_URL || "http://localhost:9000",
    crewAiUrl: process.env.CREW_AI_URL || "http://localhost:8003",
    agentSpecUrl: process.env.AGENT_SPEC_URL || "http://localhost:9003",
    pydanticAIUrl: process.env.PYDANTIC_AI_URL || "http://localhost:9000",
    adkMiddlewareUrl: process.env.ADK_MIDDLEWARE_URL || "http://localhost:8000",
    adkMiddlewareJavaUrl:
      process.env.ADK_MIDDLEWARE_JAVA_URL || "http://localhost:8027",
    agentFrameworkPythonUrl:
      process.env.AGENT_FRAMEWORK_PYTHON_URL || "http://localhost:8015",
    agentFrameworkDotnetUrl:
      process.env.AGENT_FRAMEWORK_DOTNET_URL || "http://localhost:8016",
    aguiDotnetUrl: process.env.AGUI_DOTNET_URL || "http://localhost:8023",
    springAiUrl: process.env.SPRING_AI_URL || "http://localhost:8080",
    a2aUrl: process.env.A2A_URL || "http://localhost:10002",
    a2aMiddlewareBuildingsManagementUrl:
      process.env.A2A_MIDDLEWARE_BUILDINGS_MANAGEMENT_URL ||
      "http://localhost:9001",
    a2aMiddlewareFinanceUrl:
      process.env.A2A_MIDDLEWARE_FINANCE_URL || "http://localhost:9002",
    a2aMiddlewareItUrl:
      process.env.A2A_MIDDLEWARE_IT_URL || "http://localhost:9003",
    a2aMiddlewareOrchestratorUrl:
      process.env.A2A_MIDDLEWARE_ORCHESTRATOR_URL || "http://localhost:9000",
    awsStrandsUrl: process.env.AWS_STRANDS_URL || "http://localhost:8000",
    awsStrandsTypescriptUrl:
      process.env.AWS_STRANDS_TYPESCRIPT_URL || "http://localhost:8022",
    claudeAgentSdkPythonUrl:
      process.env.CLAUDE_AGENT_SDK_PYTHON_URL || "http://localhost:8019",
    claudeAgentSdkTypescriptUrl:
      process.env.CLAUDE_AGENT_SDK_TYPESCRIPT_URL || "http://localhost:8020",
    claudeManagedAgentsDotnetUrl:
      process.env.CLAUDE_MANAGED_AGENTS_DOTNET_URL || "http://localhost:8026",
    claudeManagedAgentsPythonUrl:
      process.env.CLAUDE_MANAGED_AGENTS_PYTHON_URL || "http://localhost:8025",
    claudeManagedAgentsTypescriptUrl:
      process.env.CLAUDE_MANAGED_AGENTS_TYPESCRIPT_URL ||
      "http://localhost:8024",
    langroidUrl: process.env.LANGROID_URL || "http://localhost:8021",
    watsonxRegion: process.env.WATSONX_REGION || "",
    watsonxInstanceId: process.env.WATSONX_INSTANCE_ID || "",
    watsonxAgentId: process.env.WATSONX_AGENT_ID || "",
    watsonxApiKey: process.env.WATSONX_API_KEY || "",
    customDomainTitle: customDomainTitle,
  };
}
