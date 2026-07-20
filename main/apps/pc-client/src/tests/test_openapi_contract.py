"""共有OpenAPI契約が管理系の認可・応答境界を維持することを確認する。"""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, cast

OPENAPI_PATH: Path = Path(__file__).resolve().parents[5] / 'main' / 'packages' / 'shared' / 'api' / 'openapi.json'


def load_openapi() -> dict[str, Any]:
    """OpenAPIのJSONオブジェクトを読み込む。"""
    parsed: Any = json.loads(OPENAPI_PATH.read_text(encoding='utf-8'))
    assert isinstance(parsed, dict)
    return cast(dict[str, Any], parsed)


def resolve_schema(document: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """ローカルコンポーネント参照を解決する。"""
    reference: str | None = schema.get('$ref')
    if reference is None:
        return schema

    prefix: str = '#/components/schemas/'
    assert reference.startswith(prefix)
    return cast(dict[str, Any], document['components']['schemas'][reference.removeprefix(prefix)])


def assert_schema_accepts(document: dict[str, Any], schema: dict[str, Any], value: Any) -> None:
    """この契約で使うJSON Schemaの制限付き検証を行う。"""
    resolved: dict[str, Any] = resolve_schema(document, schema)
    expected_type: str | list[str] | None = resolved.get('type')
    expected_types: set[str] = {expected_type} if isinstance(expected_type, str) else set(expected_type or [])

    if 'null' in expected_types and value is None:
        return
    if 'object' in expected_types:
        assert isinstance(value, dict)
        properties: dict[str, Any] = resolved.get('properties', {})
        assert set(resolved.get('required', [])).issubset(value)
        if resolved.get('additionalProperties') is False:
            assert set(value).issubset(properties)
        for key, item in value.items():
            if key in properties:
                assert_schema_accepts(document, properties[key], item)
    elif 'array' in expected_types:
        assert isinstance(value, list)
        maximum_items: int | None = resolved.get('maxItems')
        if maximum_items is not None:
            assert len(value) <= maximum_items
        for item in value:
            assert_schema_accepts(document, resolved['items'], item)
    elif 'string' in expected_types:
        assert isinstance(value, str)
        minimum_length: int | None = resolved.get('minLength')
        maximum_length: int | None = resolved.get('maxLength')
        if minimum_length is not None:
            assert len(value) >= minimum_length
        if maximum_length is not None:
            assert len(value) <= maximum_length
        pattern: str | None = resolved.get('pattern')
        if pattern is not None:
            assert re.fullmatch(pattern, value)
        if resolved.get('format') == 'date-time':
            assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', value)
            parsed_datetime: datetime = datetime.fromisoformat(value.replace('Z', '+00:00'))
            assert 2000 <= parsed_datetime.year <= 2099
    elif 'integer' in expected_types:
        assert isinstance(value, int)
        assert not isinstance(value, bool)
    elif 'number' in expected_types:
        assert isinstance(value, int | float)
        assert not isinstance(value, bool)
    elif 'boolean' in expected_types:
        assert isinstance(value, bool)

    minimum: int | float | None = resolved.get('minimum')
    maximum: int | float | None = resolved.get('maximum')
    exclusive_minimum: int | float | None = resolved.get('exclusiveMinimum')
    if minimum is not None or maximum is not None or exclusive_minimum is not None:
        assert isinstance(value, int | float)
        assert not isinstance(value, bool)
        numeric_value: int | float = value
        if minimum is not None:
            assert numeric_value >= minimum
        if maximum is not None:
            assert numeric_value <= maximum
        if exclusive_minimum is not None:
            assert numeric_value > exclusive_minimum

    allowed: list[Any] | None = resolved.get('enum')
    if allowed is not None:
        assert value in allowed


def test_mutation_schemas_accept_valid_payloads_and_reject_unknown_fields() -> None:
    """更新用スキーマは正規入力を受け、追加項目を拒否する。"""
    document: dict[str, Any] = load_openapi()
    schemas: dict[str, Any] = document['components']['schemas']
    valid_review: dict[str, Any] = {
        'version': 1,
        'reviewed_text': 'りんご',
        'words': [{'display_name': 'りんご', 'normalized': 'りんご', 'new_override': 'auto'}],
        'captured_at': '2026-07-20T01:00:00Z',
        'captured_timezone': 'Asia/Tokyo',
    }

    assert_schema_accepts(document, schemas['Review'], valid_review)
    assert_schema_accepts(document, schemas['DiaryEdit'], {'version': 1, 'diary_text': 'きょうのきろく'})
    assert_schema_accepts(document, schemas['ImageRequest'], {'version': 1})

    invalid_review: dict[str, Any] = {**valid_review, 'household_id': 'household_other'}
    try:
        assert_schema_accepts(document, schemas['Review'], invalid_review)
    except AssertionError:
        pass
    else:
        raise AssertionError('unknown mutation fields must be rejected')

    for invalid_payload in (
        {**valid_review, 'version': 0},
        {**valid_review, 'captured_at': 'not-a-date'},
        {**valid_review, 'captured_at': '2026-07-20'},
        {**valid_review, 'captured_at': '1999-12-31T00:00:00Z'},
        {**valid_review, 'reviewed_text': 'あ' * 2001},
    ):
        try:
            assert_schema_accepts(document, schemas['Review'], invalid_payload)
        except (AssertionError, ValueError):
            pass
        else:
            raise AssertionError('invalid schema boundary must be rejected')


def test_management_get_routes_have_access_and_typed_success_responses() -> None:
    """管理系GET経路はAccess認証と機械可読な成功応答を定義する。"""
    document: dict[str, Any] = load_openapi()
    paths: dict[str, Any] = document['paths']
    expected_responses: dict[str, str] = {
        '/api/v1/review-queue': '#/components/responses/ReviewQueue',
        '/api/v1/diary': '#/components/responses/DiaryList',
        '/api/v1/dictionary': '#/components/responses/DictionaryList',
        '/api/v1/dictionary/{word_id}': '#/components/responses/DictionaryWord',
    }

    for path, response_ref in expected_responses.items():
        operation: dict[str, Any] = paths[path]['get']
        assert operation['security'] == [{'accessJwt': []}]
        assert operation['responses']['200']['$ref'] == response_ref


def test_management_response_schemas_are_bounded_and_correlated() -> None:
    """一覧と詳細の応答は上限付き項目と相関IDを持つ。"""
    document: dict[str, Any] = load_openapi()
    schemas: dict[str, Any] = document['components']['schemas']

    for schema_name in ('ReviewQueue', 'DiaryList', 'DictionaryList', 'DictionaryWord'):
        required: list[str] = schemas[schema_name]['required']
        assert 'correlation_id' in required

    for schema_name in ('ReviewQueue', 'DiaryList', 'DictionaryList'):
        items: dict[str, Any] = schemas[schema_name]['properties']['items']
        assert items['maxItems'] == 100

    assert schemas['ReviewQueueItem']['properties']['word_candidates']['maxItems'] == 30
    assert schemas['DictionaryWord']['properties']['history']['maxItems'] == 100
    assert schemas['ReviewQueueItem']['properties']['recording']['$ref'] == '#/components/schemas/ManagementRecording'
    management_required: list[str] = schemas['ManagementRecording']['required']
    assert {'captured_at', 'captured_timezone', 'captured_at_source', 'source_type', 'audio_endpoint'}.issubset(management_required)
    assert {'recording_id', 'surface', 'utterance_text', 'spoken_at', 'audio_endpoint'}.issubset(schemas['WordOccurrence']['required'])
    assert 'audio_endpoint' in schemas['WordOccurrence']['properties']
    assert {'captured_at', 'new_words', 'audio_endpoint'}.issubset(schemas['Diary']['required'])


def test_device_recording_schema_does_not_expose_management_content() -> None:
    """デバイス状態取得の契約に文字起こし・日記・R2キーを含めない。"""
    document: dict[str, Any] = load_openapi()
    recording_properties: dict[str, Any] = document['components']['schemas']['Recording']['properties']

    assert {'raw_text', 'reviewed_text', 'word_candidates', 'diary_text', 'audio_object_key', 'image_object_key'}.isdisjoint(recording_properties)


def test_upload_and_error_contracts_keep_server_derived_and_idempotency_rules() -> None:
    """アップロードは信頼できない送信項目を受け付けず、競合コードを公開する。"""
    document: dict[str, Any] = load_openapi()
    schemas: dict[str, Any] = document['components']['schemas']
    upload_properties: dict[str, Any] = schemas['RecordingUpload']['properties']

    assert {'source_type', 'source_id', 'captured_at_source'}.isdisjoint(upload_properties)
    assert schemas['RecordingUpload']['properties']['pre_roll_seconds']['maximum'] == 10
    assert schemas['RecordingUpload']['properties']['post_roll_seconds']['maximum'] == 5
    assert 'IDEMPOTENCY_CONFLICT' in schemas['Error']['properties']['code']['enum']
