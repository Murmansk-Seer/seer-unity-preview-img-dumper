# seer-unity-preview-img-dumper

用于从赛尔号 Unity 资源包中提取下周预告图片。

本项目为[赛尔号信息聚合页](https://seerinfo.yuyuqaq.cn/)的衍生子项目

Made with ❤️ by HurryWang(聿聿)

## 预告图片

<div align="center">
  <img src="img/combined.png" alt="res">
</div>

`preview.png` 是当前档期图；档期内的 `imgPreview_1.png` 是窗口结束后的常规图。
`combined.png` 仅用于仓库预览。档期信息直接从赛尔号官方
`game_dll_gamelogic_dll_bytes` 的 `ActivityListPreviewPanel` 解析，
与预告图片使用同一版 `DefaultPackage` 清单。
若档期信息不可用或资源版本不一致，则停止生成并报告错误，不猜测档期。
单图期的第二个地址保存相同字节，供仍请求两个固定地址的客户端去重。

## 致谢

<https://github.com/median-dxz/assets-manifest-praser>

<https://github.com/SeerAPI/Albi0>

<https://github.com/K0lb3/UnityPy>
