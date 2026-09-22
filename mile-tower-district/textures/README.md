# 실사 재질 텍스처 (선택)

기본 상태에서는 런타임에 생성한 절차적 PBR 텍스처를 씁니다.
스캔 텍스처로 바꾸려면 이 폴더에 이미지를 넣고 `manifest.json`을 만드세요. 목록에 있는 파일만 불러오므로,
없는 항목은 요청하지 않습니다.

```json
{
  "concrete": { "color": "Concrete034_1K_Color.jpg", "normal": "Concrete034_1K_NormalGL.jpg", "roughness": "Concrete034_1K_Roughness.jpg" },
  "asphalt":  { "color": "Asphalt026C_1K_Color.jpg", "normal": "Asphalt026C_1K_NormalGL.jpg", "roughness": "Asphalt026C_1K_Roughness.jpg" },
  "grass":    { "color": "Grass004_1K_Color.jpg",    "normal": "Grass004_1K_NormalGL.jpg" },
  "paving":   { "color": "PavingStones130_1K_Color.jpg", "normal": "PavingStones130_1K_NormalGL.jpg" }
}
```

추천 소스는 [ambientCG](https://ambientcg.com) (CC0)이며, 노멀맵은 OpenGL 방식(`_NormalGL`)을 쓰세요.
`file://`로 직접 열면 브라우저 보안 정책 때문에 불러오지 않으니 웹서버로 여세요.
