# FootballTodayWeb

Web hiển thị lịch thi đấu bóng đá trong ngày (dữ liệu từ [API-Football](https://www.api-football.com/)), với:

- Danh sách toàn bộ trận đấu hôm nay kèm ngày giờ.
- Bấm vào 1 trận để xem 10 trận gần nhất (có tỉ số) của mỗi đội và 10 trận đối đầu gần nhất, mỗi trận đánh dấu chấm xanh (tổng bàn thắng < 2.5) hoặc đỏ (> 2.5).
- Tab "Trận đáng chú ý": quét các trận thuộc nhóm giải đấu lớn, lọc ra trận mà ít nhất 1 trong 3 bảng thống kê trên có chênh lệch số trận đỏ/xanh ≥ 3. Có tuỳ chọn chỉ hiện trận chưa diễn ra.

## Chạy

Cần .NET 10 SDK.

```
dotnet run
```

Ứng dụng cần API key của API-Football, đọc theo thứ tự ưu tiên:

1. Biến môi trường `API_FOOTBALL_KEY`
2. File `apifootball_key.txt` (cùng thư mục project, không commit vào git) chứa key

Mặc định chạy tại `http://localhost:5108` (xem `Properties/launchSettings.json`).
