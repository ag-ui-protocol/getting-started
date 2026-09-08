// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class DocumentInputContentTests: XCTestCase {

    // MARK: - Initialization

    func test_initWithURL_setsFields() {
        let content = DocumentInputContent(url: "https://example.com/doc.pdf", mimeType: "application/pdf", title: "Annual Report")
        XCTAssertEqual(content.type, "document")
        XCTAssertEqual(content.url, "https://example.com/doc.pdf")
        XCTAssertEqual(content.mimeType, "application/pdf")
        XCTAssertEqual(content.title, "Annual Report")
        XCTAssertNil(content.data)
    }

    func test_initWithData_setsFields() {
        let content = DocumentInputContent(data: "base64pdf", mimeType: "application/pdf")
        XCTAssertEqual(content.type, "document")
        XCTAssertEqual(content.data, "base64pdf")
        XCTAssertEqual(content.mimeType, "application/pdf")
        XCTAssertNil(content.url)
    }

    func test_initWithMinimalFields_onlyURL() {
        let content = DocumentInputContent(url: "https://example.com/doc.txt")
        XCTAssertEqual(content.type, "document")
        XCTAssertNil(content.mimeType)
        XCTAssertNil(content.title)
    }

    // MARK: - Protocol conformance

    func test_conformsToInputContent() {
        let content: any InputContent = DocumentInputContent(url: "https://example.com/doc.pdf")
        XCTAssertEqual(content.type, "document")
    }

    // MARK: - DTO decoding

    func test_dtoDecodeWithURL_succeeds() throws {
        let json = Data("""
        {"type":"document","url":"https://example.com/report.pdf","mimeType":"application/pdf","title":"Report"}
        """.utf8)
        let dto = try DocumentInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertEqual(content.url, "https://example.com/report.pdf")
        XCTAssertEqual(content.mimeType, "application/pdf")
        XCTAssertEqual(content.title, "Report")
    }

    func test_dtoDecodeWithData_succeeds() throws {
        let json = Data("""
        {"type":"document","data":"base64docdata","mimeType":"text/plain"}
        """.utf8)
        let dto = try DocumentInputContentDTO.decode(from: json)
        XCTAssertEqual(dto.toDomain().data, "base64docdata")
    }

    func test_dtoDecodeWithNoSource_throws() {
        let json = Data("""
        {"type":"document","mimeType":"application/pdf"}
        """.utf8)
        XCTAssertThrowsError(try DocumentInputContentDTO.decode(from: json))
    }

    func test_dtoDecodeWithWrongType_throws() {
        let json = Data("""
        {"type":"image","url":"https://example.com/img.png"}
        """.utf8)
        XCTAssertThrowsError(try DocumentInputContentDTO.decode(from: json))
    }

    // MARK: - Integration: decode via UserMessage

    func test_userMessage_withDocumentContent_decodesFromJSON() throws {
        let json = """
        {
          "id": "msg-4",
          "role": "user",
          "content": [
            {"type": "document", "url": "https://example.com/report.pdf", "mimeType": "application/pdf", "title": "Q4 Report"}
          ]
        }
        """
        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))
        guard let userMsg = message as? UserMessage,
              let parts = userMsg.contentParts else {
            return XCTFail("Expected multimodal UserMessage")
        }
        guard let docPart = parts[0] as? DocumentInputContent else {
            return XCTFail("Expected DocumentInputContent")
        }
        XCTAssertEqual(docPart.mimeType, "application/pdf")
        XCTAssertEqual(docPart.title, "Q4 Report")
    }

    func test_userMessage_withDocumentContent_encodesCorrectly() throws {
        let doc = DocumentInputContent(url: "https://example.com/doc.pdf", mimeType: "application/pdf", title: "Report")
        let userMsg = UserMessage.multimodal(id: "msg-4", parts: [doc])

        let encoder = MessageEncoder()
        let data = try encoder.encode(userMsg)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let contentArray = json?["content"] as? [[String: Any]]

        XCTAssertEqual(contentArray?[0]["type"] as? String, "document")
        XCTAssertEqual(contentArray?[0]["mimeType"] as? String, "application/pdf")
        XCTAssertEqual(contentArray?[0]["title"] as? String, "Report")
    }

    // MARK: - Equatable / Hashable / Sendable

    func test_equalContentAreEqual() {
        XCTAssertEqual(
            DocumentInputContent(url: "https://example.com/d.pdf", mimeType: "application/pdf"),
            DocumentInputContent(url: "https://example.com/d.pdf", mimeType: "application/pdf")
        )
    }

    func test_differentURLNotEqual() {
        XCTAssertNotEqual(
            DocumentInputContent(url: "https://example.com/a.pdf"),
            DocumentInputContent(url: "https://example.com/b.pdf")
        )
    }

    func test_hashable() {
        let set: Set<DocumentInputContent> = [
            DocumentInputContent(url: "https://example.com/a.pdf"),
            DocumentInputContent(url: "https://example.com/b.pdf")
        ]
        XCTAssertEqual(set.count, 2)
    }

    func test_sendable() {
        let content = DocumentInputContent(url: "https://example.com/doc.pdf")
        Task { XCTAssertEqual(content.type, "document") }
    }
}
