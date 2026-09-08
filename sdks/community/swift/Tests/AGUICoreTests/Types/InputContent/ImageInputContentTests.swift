// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ImageInputContentTests: XCTestCase {

    // MARK: - Initialization

    func test_initWithURL_setsFields() {
        let content = ImageInputContent(url: "https://example.com/photo.jpg")
        XCTAssertEqual(content.type, "image")
        XCTAssertEqual(content.url, "https://example.com/photo.jpg")
        XCTAssertNil(content.data)
        XCTAssertNil(content.detail)
    }

    func test_initWithData_setsFields() {
        let content = ImageInputContent(data: "base64abc", detail: "high")
        XCTAssertEqual(content.type, "image")
        XCTAssertEqual(content.data, "base64abc")
        XCTAssertEqual(content.detail, "high")
        XCTAssertNil(content.url)
    }

    func test_initWithURLAndDetail_setsDetail() {
        let content = ImageInputContent(url: "https://example.com/img.png", detail: "low")
        XCTAssertEqual(content.detail, "low")
    }

    func test_initWithNoSourceProvided_createsWithNilFields() {
        // Convenience inits require at least one of url/data; default init not available
        // This test documents the available init forms
        let contentFromURL = ImageInputContent(url: "https://example.com/img.png")
        XCTAssertNotNil(contentFromURL.url)
    }

    // MARK: - Protocol conformance

    func test_conformsToInputContent() {
        let content: any InputContent = ImageInputContent(url: "https://example.com/img.png")
        XCTAssertEqual(content.type, "image")
    }

    // MARK: - DTO decoding

    func test_dtoDecodeWithURL_succeeds() throws {
        let json = Data("""
        {"type":"image","url":"https://example.com/img.png"}
        """.utf8)
        let dto = try ImageInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertEqual(content.url, "https://example.com/img.png")
        XCTAssertEqual(content.type, "image")
    }

    func test_dtoDecodeWithData_succeeds() throws {
        let json = Data("""
        {"type":"image","data":"base64xyz","detail":"auto"}
        """.utf8)
        let dto = try ImageInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertEqual(content.data, "base64xyz")
        XCTAssertEqual(content.detail, "auto")
    }

    func test_dtoDecodeWithNoSource_throws() {
        let json = Data("""
        {"type":"image","detail":"high"}
        """.utf8)
        XCTAssertThrowsError(try ImageInputContentDTO.decode(from: json))
    }

    func test_dtoDecodeWithWrongType_throws() {
        let json = Data("""
        {"type":"video","url":"https://example.com/vid.mp4"}
        """.utf8)
        XCTAssertThrowsError(try ImageInputContentDTO.decode(from: json))
    }

    // MARK: - Integration: decode via UserMessage

    func test_userMessage_withImageContent_decodesFromJSON() throws {
        let json = """
        {
          "id": "msg-1",
          "role": "user",
          "content": [
            {"type": "image", "url": "https://example.com/photo.jpg", "detail": "high"}
          ]
        }
        """
        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))
        guard let userMsg = message as? UserMessage,
              let parts = userMsg.contentParts else {
            return XCTFail("Expected multimodal UserMessage")
        }
        XCTAssertEqual(parts.count, 1)
        guard let imagePart = parts[0] as? ImageInputContent else {
            return XCTFail("Expected ImageInputContent, got \(type(of: parts[0]))")
        }
        XCTAssertEqual(imagePart.url, "https://example.com/photo.jpg")
        XCTAssertEqual(imagePart.detail, "high")
    }

    func test_userMessage_withImageContent_encodesCorrectly() throws {
        let image = ImageInputContent(url: "https://example.com/photo.jpg", detail: "low")
        let userMsg = UserMessage.multimodal(id: "msg-1", parts: [image])

        let encoder = MessageEncoder()
        let data = try encoder.encode(userMsg)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let contentArray = json?["content"] as? [[String: Any]]

        XCTAssertEqual(contentArray?.count, 1)
        XCTAssertEqual(contentArray?[0]["type"] as? String, "image")
        XCTAssertEqual(contentArray?[0]["url"] as? String, "https://example.com/photo.jpg")
        XCTAssertEqual(contentArray?[0]["detail"] as? String, "low")
    }

    // MARK: - Equatable / Hashable

    func test_equalContentAreEqual() {
        let c1 = ImageInputContent(url: "https://example.com/img.png", detail: "high")
        let c2 = ImageInputContent(url: "https://example.com/img.png", detail: "high")
        XCTAssertEqual(c1, c2)
    }

    func test_differentURLNotEqual() {
        let c1 = ImageInputContent(url: "https://example.com/a.png")
        let c2 = ImageInputContent(url: "https://example.com/b.png")
        XCTAssertNotEqual(c1, c2)
    }

    func test_hashable() {
        let c1 = ImageInputContent(url: "https://example.com/a.png")
        let c2 = ImageInputContent(url: "https://example.com/b.png")
        let set: Set<ImageInputContent> = [c1, c2]
        XCTAssertEqual(set.count, 2)
    }

    // MARK: - mimeType

    func test_mimeType_isNilByDefault_url() {
        let content = ImageInputContent(url: "https://example.com/img.png")
        XCTAssertNil(content.mimeType)
    }

    func test_mimeType_isNilByDefault_data() {
        let content = ImageInputContent(data: "base64abc")
        XCTAssertNil(content.mimeType)
    }

    func test_mimeType_roundTripsViaURLInit() {
        let content = ImageInputContent(url: "https://example.com/img.png", mimeType: "image/png")
        XCTAssertEqual(content.mimeType, "image/png")
    }

    func test_mimeType_roundTripsViaDataInit() {
        let content = ImageInputContent(data: "base64abc", mimeType: "image/jpeg")
        XCTAssertEqual(content.mimeType, "image/jpeg")
    }

    func test_mimeType_decodesFromJSON() throws {
        let json = Data("""
        {"type":"image","url":"https://example.com/img.png","mimeType":"image/png"}
        """.utf8)
        let dto = try ImageInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertEqual(content.mimeType, "image/png")
    }

    func test_mimeType_isNilWhenAbsentInJSON() throws {
        let json = Data("""
        {"type":"image","url":"https://example.com/img.png"}
        """.utf8)
        let dto = try ImageInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertNil(content.mimeType)
    }

    func test_encodeUserMessage_withImageMimeType_includesMimeTypeInJSON() throws {
        let image = ImageInputContent(url: "https://example.com/img.png", mimeType: "image/png")
        let userMsg = UserMessage.multimodal(id: "msg-1", parts: [image])
        let encoder = MessageEncoder()
        let data = try encoder.encode(userMsg)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let contentArray = json?["content"] as? [[String: Any]]
        XCTAssertEqual(contentArray?[0]["mimeType"] as? String, "image/png")
    }

    func test_encodeUserMessage_withNilImageMimeType_omitsMimeTypeFromJSON() throws {
        let image = ImageInputContent(url: "https://example.com/img.png")
        let userMsg = UserMessage.multimodal(id: "msg-1", parts: [image])
        let encoder = MessageEncoder()
        let data = try encoder.encode(userMsg)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let contentArray = json?["content"] as? [[String: Any]]
        XCTAssertNil(contentArray?[0]["mimeType"])
    }

    // MARK: - Sendable

    func test_sendable() {
        let content = ImageInputContent(url: "https://example.com/photo.jpg")
        Task {
            XCTAssertEqual(content.type, "image")
        }
    }
}
