# しつらえ（カスタムオーダー3Dシミュレーターのデモ）

色や素材を選ぶと、その場で3Dの商品に反映され、価格の計算から発注書までつながるシミュレーターのデモです。
制作: 合同会社GearBox

公開ページ: https://gearbox00.github.io/shitsurae/

## 収録しているシミュレーター

1. ランニングスニーカー（8部位・素材3種・かかとの刺しゅう）
2. 金継ぎの器（継ぎ目と欠けの色・仕上げ・高台の銘）

## デモとしての注意

1. 注文と受注一覧は、開いた端末のブラウザの中にだけ記録されます。どこにも送信されません
2. 価格や仕上げの名前は、デモ用の仮の値です

## 使っている素材

1. 靴の3Dモデル: Shopify「Materials Variants Shoe」（Khronos glTF Sample Assets、CC BY 4.0）を部位に分けて使用
   https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/MaterialsVariantsShoe
2. 器の3Dモデル: GearBox がプログラムで作成
3. three.js 0.186.1（MIT License）を `vendor/` に同梱
4. 書体: Google Fonts（Zen Kaku Gothic New、Dela Gothic One、IBM Plex Mono、Shippori Mincho、Yuji Syuku、Caveat）
