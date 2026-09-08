require_relative "lib/ag_ui_protocol/version"

Gem::Specification.new do |spec|
  spec.name = "ag-ui-protocol"
  spec.version = AgUiProtocol::VERSION
  spec.authors = ["Buk"]
  spec.email = ["contacto@buk.cl"]

  spec.summary = "Ruby SDK for AG-UI protocol"
  spec.description = "Ruby SDK for AG-UI protocol - standardizing agent-user interactions through event-based communication"
  spec.license = "MIT"
  spec.homepage = "https://docs.ag-ui.com/introduction"

  spec.files = Dir.glob("{lib}/**/*") + ["LICENSE"]
  spec.require_paths = ["lib"]

  spec.required_ruby_version = ">= 3.0"

  spec.add_dependency "json", ">= 0"
  spec.add_dependency "sorbet-runtime", ">= 0.5.12392"

  spec.add_development_dependency "minitest", ">= 5.0"
  spec.add_development_dependency "minitest-reporters", ">= 1.7.1"
  spec.add_development_dependency "shoulda-context", ">= 2.0"
  spec.add_development_dependency "rake"
  spec.add_development_dependency "sorbet", ">= 0.5.12392"
  spec.add_development_dependency "yard", ">= 0.9"
  spec.add_development_dependency "yard-markdown", ">= 0.3"

  spec.metadata["rubygems_mfa_required"] = "true"
  spec.metadata["source_code_uri"] = "https://github.com/ag-ui-protocol/ag-ui"
  spec.metadata["documentation_uri"] = "https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/community/ruby/README.md"
  spec.metadata["changelog_uri"] = "https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/community/ruby/CHANGELOG.md"
  spec.metadata["homepage_uri"] = "https://docs.ag-ui.com/introduction"
end
