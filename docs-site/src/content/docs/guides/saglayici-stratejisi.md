---
title: Sağlayıcı anahtar stratejisi
description: Bir anahtar bozulduğunda aynı sohbeti çalışan anahtarla sürdürme.
---

**Sağlayıcılar → sağlayıcın → Strateji** yolundan seç. Combo oluşturman gerekmez.
Aynı sağlayıcı bir combo içinde kullanıldığında da anahtar seçimi geçerlidir.

| Seçim | Ne yapar? |
| --- | --- |
| Çalışanı seç | Yakın zamanda çalışan anahtarları öne alır. Anahtar reddedilirse aynı isteği uygun diğer anahtarla sürdürür. Varsayılandır. |
| Sırayla paylaştır | İstekleri uygun anahtarlar arasında sırayla dağıtır. |
| Rastgele seç | Uygun anahtarlardan birini rastgele seçer. |
| En az kullanılanı seç | Kaydedilen istek sayısı daha az olan anahtarı öne alır. |
| Kotası önce yenilenecek olanı seç | Sağlayıcının bildirdiği yenilenme zamanına göre seçer. Bu bilgi yoksa çalışan anahtarların yakın sonuçlarını kullanır. |

Seçim hemen kaydedilir. Sonuç tablosundaki **Kabul**, sağlayıcının anahtarla
gönderilen isteği kabul ettiğini gösterir. **Ret**, anahtara özgü kimlik/kota
hatasıdır. Bunlar cevabın tamamlandığını göstermez. Seçim puanı yakın sonuçlardan
öğrenilir ve eski sonuçların etkisi zamanla azalır. Anahtarın veya adresin değişmesi
eski kanıtı o yeni kimliğin kanıtı yapmaz.

Anahtar reddedildiğinde sohbeti yeniden başlatman gerekmez: yanıt başlamamışsa
aynı istek çalışan diğer anahtarda devam eder. Havuzdaki anahtarlar için deneme
hakkı vardır; genel dört gönderim sınırı havuzun geri kalanını kapatmaz.
Kurtarma iptal isteğini ve gönderim bütçesini korur. Başlamış bir yanıtı gizlice
baştan üretmez, başka modele geçmez.

Hesap kullanan veya yerel model çalıştıran sağlayıcıya API-key stratejisi uygulanmaz.
Eski fill-first ve quota ayarları korunur; seçilmişse arayüzde görünürler.

Bu değişiklik için test yazılmadı veya çalıştırılmadı. Derleme ve statik kontroller
canlı sağlayıcıda uçtan uca doğrulama anlamına gelmez.
